/**
 * Task orchestration loop: workspace init, architecture phase, agent turns, quality gates.
 */

import {
  validateArchitectStepResult,
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
import type { AgentRole } from "./actors.js";
import {
  createSandboxGitRunner,
  finalizeGitWorkspace,
  initializeGitWorkspace,
  cleanupWorkspaceScratchFiles,
  readBlueprintStep,
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
import { collectWorkspaceChanges, releaseWorkspaceDiskLocks } from "./workspaceGit.js";
import { cleanupDockerContainers, killAllTrackedProcesses } from "./processRegistry.js";
import {
  beginAgentTurn,
  clearLiveTaskProgress,
  endAgentTurn,
  getLiveTaskProgress,
  logCompletedStepTools,
  type LiveTaskProgress,
} from "./taskObservability.js";
import { loadStepRecords, saveStepRecord, saveTaskState } from "./database.js";
import type { TaskStatus } from "./types.js";

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
  readonly orchestrationRunning: boolean;
  readonly liveProgress: LiveTaskProgress;
}

const runtimeByTask = new Map<TaskId, TaskRuntimeSnapshot>();
const orchestrationAbortControllers = new Map<TaskId, AbortController>();

function statusAllowsArchitectureDispatch(status: TaskStatus): boolean {
  return status === "PLANNING" || status === "EXECUTING";
}

export function abortActiveOrchestration(taskId: TaskId): boolean {
  const controller = orchestrationAbortControllers.get(taskId);
  if (!controller) {
    return false;
  }
  controller.abort();
  return true;
}

export function isOrchestrationAborted(taskId: TaskId): boolean {
  return orchestrationAbortControllers.get(taskId)?.signal.aborted ?? false;
}

export function isOrchestrationRunning(taskId: TaskId): boolean {
  const controller = orchestrationAbortControllers.get(taskId);
  return controller !== undefined && !controller.signal.aborted;
}

const MAX_CODER_DELIVERABLE_ATTEMPTS = 3;

export async function terminateTaskOrchestration(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string,
  mode: "cancel" | "abort",
  by: string,
  reason?: string
): Promise<TaskState> {
  abortActiveOrchestration(taskId);
  await killAllTrackedProcesses("SIGKILL");
  await cleanupDockerContainers();
  try {
    await releaseWorkspaceDiskLocks(sandboxRoot);
  } catch {
    // Best-effort cleanup — do not block terminal transition.
  }

  const signal =
    mode === "cancel"
      ? reason !== undefined
        ? { kind: "TASK_CANCELLED" as const, by, reason }
        : { kind: "TASK_CANCELLED" as const, by }
      : reason !== undefined
        ? { kind: "TASK_ABORTED" as const, by, reason }
        : { kind: "TASK_ABORTED" as const, by };

  return sm.dispatch(taskId, signal);
}

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

  const persistedRows = priorSteps.length > 0 ? null : await loadStepRecords(taskId);
  const tokenUsage =
    priorSteps.length > 0
      ? summarizeTokenUsage(priorSteps)
      : summarizeTokenUsage(
          (persistedRows ?? []).map((row) => ({
            stepId: row.stepId as StepResult["stepId"],
            taskId,
            agentId: row.agentId as StepResult["agentId"],
            toolCalls: [],
            producedArtifacts: [],
            narrativeSummary: row.narrativeSummary,
            usage: row.usage,
            timestampMs: row.timestampMs,
          }))
        );

  const lastStep = priorSteps.at(-1) ?? null;
  const lastPersisted = persistedRows?.at(-1) ?? null;
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
    tokenUsage,
    lastStepRole: lastStep?.agentId ?? lastPersisted?.agentId ?? null,
    lastStepSummary: lastStep?.narrativeSummary ?? lastPersisted?.narrativeSummary ?? null,
    branch,
    orchestrationRunning: isOrchestrationRunning(taskId),
    liveProgress: getLiveTaskProgress(taskId),
  };
  runtimeByTask.set(taskId, snapshot);
  return snapshot;
}

function shouldAutoApproveBlueprint(): boolean {
  return loadMamsEnv().MAMS_AUTO_APPROVE_BLUEPRINT;
}

async function persistCompletedStep(
  taskId: TaskId,
  role: AgentRole,
  stepIndex: number,
  stepResult: StepResult
): Promise<void> {
  logCompletedStepTools(taskId, role, stepResult);
  await saveStepRecord(taskId, stepIndex, role, stepResult);
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

  if (
    statusAllowsArchitectureDispatch(state.status) &&
    state.architectureAlignmentStatus !== "approved" &&
    state.status !== "ARCHITECTING"
  ) {
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

type CoderDeliverableOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "retry"; readonly failures: number }
  | { readonly kind: "reject"; readonly state: TaskState };

async function validateCoderDeliverableWithRetry(
  sm: StateMachine,
  taskId: TaskId,
  stepResult: StepResult,
  sandboxRoot: string,
  executedBlueprintStepIndex: number,
  failureStreak: number
): Promise<CoderDeliverableOutcome> {
  const blueprintStepText =
    executedBlueprintStepIndex >= 0
      ? await readBlueprintStep(sandboxRoot, executedBlueprintStepIndex)
      : null;
  const validation = await validateCoderDeliverable(
    stepResult,
    createSandboxGitRunner(sandboxRoot),
    blueprintStepText
  );
  if (validation.ok) {
    return { kind: "ok" };
  }

  const nextFailures = failureStreak + 1;
  if (nextFailures < MAX_CODER_DELIVERABLE_ATTEMPTS) {
    console.warn(
      `[orchestrator] CODER deliverable incomplete for "${taskId}" (attempt ${nextFailures}/${MAX_CODER_DELIVERABLE_ATTEMPTS} on blueprint step ${executedBlueprintStepIndex + 1}): ${validation.reason}`
    );
    await sm.dispatch(taskId, { kind: "BLUEPRINT_STEP_RETRY", stepIndex: executedBlueprintStepIndex });
    return { kind: "retry", failures: nextFailures };
  }

  return { kind: "reject", state: await rejectDeliverable(sm, taskId, validation.reason) };
}

async function afterArchitectTurn(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string,
  stepResult: StepResult,
  priorSteps: readonly StepResult[]
): Promise<TaskState | "retry"> {
  const state = await sm.getTaskState(taskId);
  const toolCheck = validateArchitectStepResult(stepResult);
  const artifactsOk = await validateArchitectureArtifacts(sandboxRoot, { stepResult });

  if (!artifactsOk || !toolCheck.ok) {
    const architectAttempts = priorSteps.filter((step) => step.agentId.includes("architect")).length;
    if (architectAttempts < state.retry.max) {
      console.warn(
        `[orchestrator] ARCHITECT incomplete for "${taskId}" (attempt ${architectAttempts}/${state.retry.max}): ${
          toolCheck.ok ? "artifacts invalid or stale (no active write_file this turn)" : toolCheck.reason
        }`
      );
      return "retry";
    }
    return rejectDeliverable(
      sm,
      taskId,
      toolCheck.ok
        ? "ARCHITECT did not produce valid .mams-rules.md and task-blueprint.md artifacts."
        : toolCheck.reason
    );
  }
  const steps = await readBlueprintSteps(sandboxRoot);
  await sm.dispatch(taskId, { kind: "ARCHITECTURE_ARTIFACTS_READY", totalSteps: steps.length });
  return maybeAutoApproveBlueprint(sm, taskId);
}

async function loadPriorStepsFromDb(taskId: TaskId): Promise<StepResult[]> {
  const rows = await loadStepRecords(taskId);
  return rows.map((row) => ({
    stepId: row.stepId as StepResult["stepId"],
    taskId,
    agentId: row.agentId as StepResult["agentId"],
    toolCalls: [],
    producedArtifacts: [],
    narrativeSummary: row.narrativeSummary,
    usage: row.usage,
    timestampMs: row.timestampMs,
  }));
}

export async function runTaskOrchestration(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string
): Promise<void> {
  const priorSteps: StepResult[] = await loadPriorStepsFromDb(taskId);
  const maxIterations = 250;
  const abortController = new AbortController();
  orchestrationAbortControllers.set(taskId, abortController);

  try {
    await runTaskOrchestrationInner(sm, taskId, sandboxRoot, priorSteps, maxIterations, abortController.signal);
  } finally {
    orchestrationAbortControllers.delete(taskId);
    endAgentTurn(taskId);
    clearLiveTaskProgress(taskId);
    await cleanupWorkspaceScratchFiles(sandboxRoot).catch((err) => {
      console.warn(`[orchestrator] Scratch cleanup failed for "${taskId}":`, err);
    });
  }
}

async function runTaskOrchestrationInner(
  sm: StateMachine,
  taskId: TaskId,
  sandboxRoot: string,
  priorSteps: StepResult[],
  maxIterations: number,
  abortSignal: AbortSignal
): Promise<void> {

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

  let coderDeliverableFailures = 0;

  for (let i = 0; i < maxIterations; i += 1) {
    if (abortSignal.aborted || isOrchestrationAborted(taskId)) {
      console.log(`[orchestrator] Task "${taskId}" orchestration aborted.`);
      return;
    }

    state = await sm.getTaskState(taskId);

    if (statusAllowsArchitectureDispatch(state.status)) {
      state = await prepareArchitectureIfNeeded(sm, taskId, sandboxRoot);
      state = await maybeAutoApproveBlueprint(sm, taskId);
    }

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
      const executedBlueprintStepIndex =
        role === "CODER" && state.blueprintTotalSteps > 0 ? state.blueprintStepIndex : -1;
      beginAgentTurn(taskId, role);
      let stepResult: StepResult;
      let nextState: TaskState;
      try {
        ({ state: nextState, stepResult } = await sm.executeAgentTurn(taskId, role, sandboxRoot, priorSteps, {
          skipDispatch: role === "CODER",
        }));
      } finally {
        endAgentTurn(taskId);
      }
      if (role === "CODER" && state.blueprintTotalSteps > 0) {
        (stepResult.usage as any).blueprintStepIndex = state.blueprintStepIndex;
      }
      await cleanupWorkspaceScratchFiles(sandboxRoot).catch((err) => {
        console.warn(`[orchestrator] Scratch cleanup failed after step for "${taskId}":`, err);
      });

      if (role === "ARCHITECT" && previousStatus === "ARCHITECTING") {
        priorSteps.push(stepResult);
        await persistCompletedStep(taskId, role, nextState.history.length - 1, stepResult);
        const architectOutcome = await afterArchitectTurn(sm, taskId, sandboxRoot, stepResult, priorSteps);
        if (architectOutcome === "retry") {
          await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
          continue;
        }
        state = architectOutcome;
        await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
        continue;
      }

      if (role === "CODER") {
        const coderOutcome = await validateCoderDeliverableWithRetry(
          sm,
          taskId,
          stepResult,
          sandboxRoot,
          executedBlueprintStepIndex,
          coderDeliverableFailures
        );
        if (coderOutcome.kind === "retry") {
          coderDeliverableFailures = coderOutcome.failures;
          state = await sm.getTaskState(taskId);
          await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
          continue;
        }
        if (coderOutcome.kind === "reject") {
          priorSteps.push(stepResult);
          await persistCompletedStep(taskId, role, (await sm.getTaskState(taskId)).history.length, stepResult);
          await refreshRuntimeSnapshot(taskId, coderOutcome.state, priorSteps, sandboxRoot);
          return;
        }
        coderDeliverableFailures = 0;
        nextState = await sm.dispatch(taskId, {
          kind: "STEP_RESULT",
          stepId: stepResult.stepId,
          result: stepResult,
        });
      } else {
        const rejection = await validateRoleDeliverable(sm, taskId, role, stepResult, sandboxRoot);
        if (rejection) {
          priorSteps.push(stepResult);
          await persistCompletedStep(taskId, role, nextState.history.length - 1, stepResult);
          await refreshRuntimeSnapshot(taskId, rejection, priorSteps, sandboxRoot);
          return;
        }
      }

      priorSteps.push(stepResult);
      await persistCompletedStep(taskId, role, nextState.history.length - 1, stepResult);

      state = nextState;
      await refreshRuntimeSnapshot(taskId, state, priorSteps, sandboxRoot);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        console.error(`[orchestrator] Invalid transition for "${taskId}":`, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (role === "CODER" && /invalid x-api-key|api key|authentication/i.test(message)) {
        try {
          const failedState = await sm.getTaskState(taskId);
          if (failedState.preferredProvider !== "GOOGLE") {
            console.warn(
              `[orchestrator] LLM auth error for "${taskId}" — resetting preferredProvider to GOOGLE and retrying.`
            );
            await saveTaskState({ ...failedState, preferredProvider: "GOOGLE" });
            await refreshRuntimeSnapshot(taskId, failedState, priorSteps, sandboxRoot);
            continue;
          }
        } catch {
          // Fall through to stop orchestration.
        }
      }
      console.error(`[orchestrator] Task "${taskId}" orchestration error (${role ?? "unknown"}):`, message);
      try {
        const failedState = await sm.getTaskState(taskId);
        await refreshRuntimeSnapshot(taskId, failedState, priorSteps, sandboxRoot);
      } catch {
        // Best-effort snapshot before stopping the loop.
      }
      return;
    }
  }

  console.error(`[orchestrator] Task "${taskId}" exceeded max orchestration iterations.`);
}
