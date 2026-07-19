/**
 * Task orchestration loop: workspace init, architecture phase, agent turns, quality gates.
 */

import {
  validateCoderDeliverable,
  validatePreDoneDeliverables,
  validateTesterStepResult,
} from "./deliverableValidation.js";
import { loadMamsEnv } from "./env.js";
import {
  InvalidTransitionError,
  resolveAgentRoleForStatus,
  StateMachine,
} from "./fsmEngine.js";
import {
  assessWorkspaceContext,
  createSandboxGitRunner,
  finalizeGitWorkspace,
  initializeGitWorkspace,
  readBlueprintSteps,
  validateArchitectureArtifacts,
} from "./tools.js";
import {
  isTerminalStatus,
  tierNeedsArchitectureAlignment,
  tierUsesSandbox,
  type StepResult,
  type TaskId,
  type TaskState,
} from "./types.js";
import { collectWorkspaceChanges } from "./workspaceGit.js";

export interface TaskRuntimeSnapshot {
  readonly taskId: TaskId;
  readonly status: TaskState["status"];
  readonly executionTier: TaskState["executionTier"];
  readonly history: readonly string[];
  readonly blueprintStepIndex: number;
  readonly blueprintTotalSteps: number;
  readonly architectureAlignmentStatus: TaskState["architectureAlignmentStatus"];
  readonly changedFiles: readonly string[];
  readonly meaningfulChangedFiles: readonly string[];
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
  };
  readonly lastStepRole: string | null;
  readonly lastStepSummary: string | null;
  readonly branch: string | null;
}

const runtimeByTask = new Map<TaskId, TaskRuntimeSnapshot>();

function summarizeTokenUsage(steps: readonly StepResult[]): TaskRuntimeSnapshot["tokenUsage"] {
  return steps.reduce(
    (acc, step) => ({
      inputTokens: acc.inputTokens + step.usage.inputTokens,
      outputTokens: acc.outputTokens + step.usage.outputTokens,
      estimatedCostUsd: acc.estimatedCostUsd + step.usage.estimatedCostUsd,
    }),
    { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  );
}

export function getTaskRuntimeSnapshot(taskId: TaskId): TaskRuntimeSnapshot | null {
  return runtimeByTask.get(taskId) ?? null;
}

async function refreshRuntimeSnapshot(
  taskId: TaskId,
  state: TaskState,
  priorSteps: readonly StepResult[],
  sandboxRoot: string,
  branch: string | null = null
): Promise<TaskRuntimeSnapshot> {
  let changedFiles: string[] = [];
  let meaningfulChangedFiles: string[] = [];
  try {
    const changes = await collectWorkspaceChanges(createSandboxGitRunner(sandboxRoot));
    changedFiles = [...changes.allPaths];
    meaningfulChangedFiles = [...changes.meaningfulPaths];
  } catch {
    // workspace may not be git-backed
  }

  const lastStep = priorSteps.at(-1) ?? null;
  const snapshot: TaskRuntimeSnapshot = {
    taskId,
    status: state.status,
    executionTier: state.executionTier,
    history: state.history,
    blueprintStepIndex: state.blueprintStepIndex,
    blueprintTotalSteps: state.blueprintTotalSteps,
    architectureAlignmentStatus: state.architectureAlignmentStatus,
    changedFiles,
    meaningfulChangedFiles,
    tokenUsage: summarizeTokenUsage(priorSteps),
    lastStepRole: lastStep?.agentId ?? null,
    lastStepSummary: lastStep?.narrativeSummary ?? null,
    branch,
  };
  runtimeByTask.set(taskId, snapshot);
  return snapshot;
}

function shouldAutoApproveBlueprint(): boolean {
  return loadMamsEnv().MAMS_AUTO_APPROVE_BLUEPRINT;
}

async function prepareArchitectureIfNeeded(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string
): Promise<TaskState> {
  const state = await sm.getTaskState(taskId);
  if (!tierUsesSandbox(state.executionTier) || !tierNeedsArchitectureAlignment(state.executionTier)) {
    return state;
  }

  const assessment = await assessWorkspaceContext(sandboxRoot);
  if (!assessment.requiresArchitectureAlignment) {
    return state;
  }

  if (await validateArchitectureArtifacts(sandboxRoot)) {
    const steps = await readBlueprintSteps(sandboxRoot);
    if (steps.length > 0 && state.blueprintTotalSteps === 0) {
      return sm.dispatch(taskId, { kind: "ARCHITECTURE_ARTIFACTS_READY", totalSteps: steps.length });
    }
    return state;
  }

  if (state.status === "EXECUTING") {
    return sm.dispatch(taskId, { kind: "ARCHITECTURE_REQUIRED" });
  }

  return state;
}

async function maybeAutoApproveBlueprint(sm: StateMachine, taskId: TaskId): Promise<TaskState> {
  let state = await sm.getTaskState(taskId);
  if (state.status === "AWAITING_APPROVAL" && state.awaitingApprovalKind === "blueprint") {
    if (shouldAutoApproveBlueprint()) {
      console.log(`[orchestrator] Auto-approving blueprint for task "${taskId}".`);
      state = await sm.dispatch(taskId, { kind: "APPROVAL_GRANTED", by: "mams-auto" });
    } else {
      console.log(`[orchestrator] Task "${taskId}" awaiting blueprint approval via POST /api/mams/task/:id/approve`);
    }
  }
  return state;
}

async function rejectDeliverable(sm: StateMachine, taskId: TaskId, reason: string): Promise<TaskState> {
  console.error(`[orchestrator] Deliverable rejected for "${taskId}": ${reason}`);
  return sm.dispatch(taskId, { kind: "DELIVERABLE_REJECTED", reason });
}

async function validateRoleDeliverable(
  sm: StateMachine,
  taskId: TaskId,
  role: ReturnType<typeof resolveAgentRoleForStatus>,
  stepResult: StepResult,
  sandboxRoot: string
): Promise<TaskState | null> {
  const gitRunner = createSandboxGitRunner(sandboxRoot);

  if (role === "CODER") {
    const validation = await validateCoderDeliverable(stepResult, gitRunner);
    if (!validation.ok) {
      return rejectDeliverable(sm, taskId, validation.reason);
    }
  }

  if (role === "TESTER") {
    const testerToolCheck = validateTesterStepResult(stepResult);
    if (!testerToolCheck.ok) {
      return rejectDeliverable(sm, taskId, testerToolCheck.reason);
    }
    const workspaceCheck = await validatePreDoneDeliverables(gitRunner);
    if (!workspaceCheck.ok) {
      return rejectDeliverable(sm, taskId, workspaceCheck.reason);
    }
    const narrative = stepResult.narrativeSummary.toLowerCase();
    if (/\bfail(ed|ure)?\b/.test(narrative) && !/\bpass(ed|es)?\b/.test(narrative)) {
      return rejectDeliverable(sm, taskId, "TESTER reported failure in narrative.");
    }
  }

  return null;
}

async function afterArchitectTurn(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string
): Promise<TaskState> {
  if (!(await validateArchitectureArtifacts(sandboxRoot))) {
    return rejectDeliverable(
      sm,
      taskId,
      "ARCHITECT did not produce valid .mams-rules.md and task-blueprint.md artifacts."
    );
  }
  const steps = await readBlueprintSteps(sandboxRoot);
  await sm.dispatch(taskId, { kind: "ARCHITECTURE_ARTIFACTS_READY", totalSteps: steps.length });
  return maybeAutoApproveBlueprint(sm, taskId);
}

export async function runTaskOrchestration(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string
): Promise<void> {
  const priorSteps: StepResult[] = [];
  const maxIterations = 250;

  const initialState = await sm.getTaskState(taskId);
  if (tierUsesSandbox(initialState.executionTier)) {
    try {
      await initializeGitWorkspace(sandboxRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] Workspace init failed for "${taskId}":`, message);
      return;
    }
  }

  let state = await prepareArchitectureIfNeeded(sm, taskId, sandboxRoot);
  state = await maybeAutoApproveBlueprint(sm, taskId);
  await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);

  for (let i = 0; i < maxIterations; i += 1) {
    state = await sm.getTaskState(taskId);

    if (isTerminalStatus(state.status)) {
      let branch: string | null = null;
      if (state.status === "DONE" && tierUsesSandbox(state.executionTier)) {
        const preDone = await validatePreDoneDeliverables(createSandboxGitRunner(sandboxRoot));
        if (!preDone.ok) {
          console.error(`[orchestrator] Blocking DONE git finalize: ${preDone.reason}`);
          await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
          return;
        }
        try {
          const coderSummary =
            [...priorSteps].reverse().find((step) => step.agentId.includes("coder"))?.narrativeSummary ?? null;
          const gitResult = await finalizeGitWorkspace(taskId, sandboxRoot, {
            objective: state.contract.objective,
            acceptanceCriteria: state.contract.acceptanceCriteria,
            coderSummary,
          });
          branch = gitResult.branch;
          console.log(`[orchestrator] Git finalize for "${taskId}":`, gitResult);
          if (gitResult.skippedReason === "no_meaningful_changes") {
            console.error(`[orchestrator] Task "${taskId}" reached DONE but no meaningful git changes to push.`);
          }
        } catch (err) {
          console.error(`[orchestrator] Git finalize failed for "${taskId}":`, err);
        }
      }
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot, branch);
      console.log(`[orchestrator] Task "${taskId}" reached terminal status "${state.status}".`);
      return;
    }

    if (state.status === "AWAITING_CLOUD_VERIFICATION") {
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
      console.log(`[orchestrator] Task "${taskId}" awaiting cloud webhook — pausing loop.`);
      return;
    }

    if (state.status === "ESCALATED") {
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
      console.log(`[orchestrator] Task "${taskId}" escalated — requires human input.`);
      return;
    }

    if (state.status === "AWAITING_APPROVAL" && !resolveAgentRoleForStatus(state)) {
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
      console.log(`[orchestrator] Task "${taskId}" requires human input at "${state.status}".`);
      return;
    }

    const role = resolveAgentRoleForStatus(state);
    if (!role) {
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
      console.log(`[orchestrator] No agent role for status "${state.status}" — stopping.`);
      return;
    }

    try {
      const previousStatus = state.status;
      const { state: nextState, stepResult } = await sm.executeAgentTurn(taskId, role, sandboxRoot, priorSteps);
      priorSteps.push(stepResult);

      if (role === "ARCHITECT" && previousStatus === "ARCHITECTING") {
        state = await afterArchitectTurn(sm, taskId, sandboxRoot);
        await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
        continue;
      }

      const rejection = await validateRoleDeliverable(sm, taskId, role, stepResult, sandboxRoot);
      if (rejection) {
        await refreshRuntimeSnapshot(taskId, rejection, priorSteps, sandboxRoot);
        return;
      }

      state = nextState;
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        console.error(`[orchestrator] Invalid transition for "${taskId}":`, err.message);
        return;
      }
      throw err;
    }
  }

  console.error(`[orchestrator] Task "${taskId}" exceeded max orchestration iterations.`);
}
