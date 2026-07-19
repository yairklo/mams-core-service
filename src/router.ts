/**
 * HTTP router for n8n webhook integration and cloud deployment callbacks.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type Response, type Router } from "express";
import { z } from "zod";

import {
  InvalidTransitionError,
  resolveAgentRoleForStatus,
  StateMachine,
  type CreateTaskOptions,
} from "./fsmEngine.js";
import {
  AGENT_WORKSPACES_BASE_DIR,
  assertSandboxRootIsContained,
  finalizeGitWorkspace,
  initializeGitWorkspace,
} from "./tools.js";
import {
  asSessionId,
  asTaskId,
  isTerminalStatus,
  tierUsesSandbox,
  type CloudVerificationStatus,
  type LlmProvider,
  type PmContext,
  type TaskId,
} from "./types.js";

const StartTaskBodySchema = z.object({
  objective: z.string().min(1),
  executionTier: z.enum([
    "TIER1_FAST_TRACK",
    "TIER2_STANDARD",
    "TIER3_CRITICAL",
    "TIER4_ENTERPRISE_E2E",
  ]),
  pmContext: z
    .object({
      initialRequest: z.record(z.unknown()).optional(),
      clarifyingQuestions: z.array(z.string()).optional(),
      developerReplies: z.array(z.string()).optional(),
    })
    .optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  deadlineMs: z.number().int().positive().optional(),
  preferredProvider: z.enum(["GOOGLE", "ANTHROPIC"]).optional(),
  modelOverride: z.string().min(1).optional(),
});

const CloudWebhookBodySchema = z.object({
  taskId: z.string().min(1),
  provider: z.string().min(1),
  status: z.enum(["success", "failure"]),
  errorLogs: z.string().optional(),
});

export interface MamsRouterDeps {
  readonly stateMachine?: StateMachine;
  readonly defaultDeadlineMs?: number;
  readonly fiscalBudgetLimitUsd?: number;
}

function buildContract(taskId: TaskId, objective: string, acceptanceCriteria: readonly string[]) {
  const createdAt = Date.now();
  const payload = JSON.stringify({ taskId, objective, acceptanceCriteria, createdAt });
  return {
    taskId,
    objective,
    acceptanceCriteria,
    groundTruthArtifacts: [],
    createdAt,
    immutableHash: createHash("sha256").update(payload).digest("hex"),
  };
}

function sandboxPathForTask(taskId: TaskId): string {
  const path = join(AGENT_WORKSPACES_BASE_DIR, taskId);
  mkdirSync(path, { recursive: true });
  return assertSandboxRootIsContained(path);
}

export function createMamsRouter(deps: MamsRouterDeps = {}): Router {
  const router = express.Router();
  const sm =
    deps.stateMachine ??
    new StateMachine({
      maxStepsPerTask: 200,
    });

  router.post("/task/start", async (req: Request, res: Response) => {
    const parsed = StartTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.toString() });
      return;
    }

    const taskId = asTaskId(randomUUID());
    const sessionId = asSessionId(parsed.data.sessionId ?? randomUUID());
    const now = Date.now();
    const deadlineMs = parsed.data.deadlineMs ?? deps.defaultDeadlineMs ?? 3_600_000;

    const options: CreateTaskOptions = {
      taskId,
      sessionId,
      contract: buildContract(taskId, parsed.data.objective, parsed.data.acceptanceCriteria ?? []),
      costScopeId: `scope-${taskId}`,
      deadline: { absoluteMs: now + deadlineMs, softWarnAtRatio: 0.8 },
      executionTier: parsed.data.executionTier,
      pmContext: (parsed.data.pmContext as PmContext | undefined) ?? null,
      ...(parsed.data.preferredProvider ? { preferredProvider: parsed.data.preferredProvider as LlmProvider } : {}),
      ...(parsed.data.modelOverride ? { modelOverride: parsed.data.modelOverride } : {}),
    };

    try {
      await sm.createTask(options);
    } catch (err) {
      console.error("[router] createTask failed:", err);
      res.status(500).json({ error: "Failed to create task" });
      return;
    }

    res.status(202).json({
      taskId,
      status: "accepted",
      executionTier: parsed.data.executionTier,
      message: "Task accepted; orchestration running in background.",
    });

    void runTaskOrchestration(sm, taskId).catch((err) => {
      console.error(`[router] orchestration crashed for task "${taskId}":`, err);
    });
  });

  router.post("/webhook/cloud", async (req: Request, res: Response) => {
    try {
      const result = await handleCloudWebhook(req.body, sm);
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/task/:taskId", async (req: Request, res: Response) => {
    const rawId = req.params.taskId;
    const taskIdParam = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!taskIdParam) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }
    try {
      const state = await sm.getTaskState(asTaskId(taskIdParam));
      res.json({ taskId: state.taskId, status: state.status, executionTier: state.executionTier, history: state.history });
    } catch {
      res.status(404).json({ error: "Task not found" });
    }
  });

  return router;
}

export interface CloudWebhookInput {
  readonly taskId: string;
  readonly provider: string;
  readonly status: CloudVerificationStatus;
  readonly errorLogs?: string;
}

export async function handleCloudWebhook(
  input: unknown,
  stateMachine: StateMachine = new StateMachine()
): Promise<{ taskId: string; status: string }> {
  const parsed = CloudWebhookBodySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.toString());
  }

  const taskId = asTaskId(parsed.data.taskId);
  const current = await stateMachine.getTaskState(taskId);

  if (current.status !== "AWAITING_CLOUD_VERIFICATION") {
    throw new Error(
      `Task "${taskId}" is in status "${current.status}", not AWAITING_CLOUD_VERIFICATION.`
    );
  }

  const next = await stateMachine.dispatch(taskId, {
    kind: "CLOUD_VERIFICATION_RESULT",
    provider: parsed.data.provider,
    status: parsed.data.status,
    ...(parsed.data.errorLogs !== undefined ? { errorLogs: parsed.data.errorLogs } : {}),
  });

  if (!isTerminalStatus(next.status) && next.status !== "ESCALATED") {
    void runTaskOrchestration(stateMachine, taskId).catch((err) => {
      console.error(`[router] post-cloud orchestration failed for "${taskId}":`, err);
    });
  }

  return { taskId: next.taskId, status: next.status };
}

export async function runTaskOrchestration(sm: StateMachine, taskId: TaskId): Promise<void> {
  const priorSteps: never[] = [];
  const sandboxRoot = sandboxPathForTask(taskId);
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

  for (let i = 0; i < maxIterations; i += 1) {
    const state = await sm.getTaskState(taskId);

    if (isTerminalStatus(state.status)) {
      if (state.status === "DONE" && tierUsesSandbox(state.executionTier)) {
        try {
          const gitResult = await finalizeGitWorkspace(taskId, sandboxRoot, state.contract.objective);
          console.log(`[orchestrator] Git finalize for "${taskId}":`, gitResult);
        } catch (err) {
          console.error(`[orchestrator] Git finalize failed for "${taskId}":`, err);
        }
      }
      console.log(`[orchestrator] Task "${taskId}" reached terminal status "${state.status}".`);
      return;
    }

    if (state.status === "AWAITING_CLOUD_VERIFICATION") {
      console.log(`[orchestrator] Task "${taskId}" awaiting cloud webhook — pausing loop.`);
      return;
    }

    if (state.status === "ESCALATED" || state.status === "AWAITING_APPROVAL" && !resolveAgentRoleForStatus(state)) {
      console.log(`[orchestrator] Task "${taskId}" requires human input at "${state.status}".`);
      return;
    }

    const role = resolveAgentRoleForStatus(state);
    if (!role) {
      console.log(`[orchestrator] No agent role for status "${state.status}" — stopping.`);
      return;
    }

    try {
      await sm.executeAgentTurn(taskId, role, sandboxRoot, priorSteps);
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

export function mountMamsRoutes(app: Express, deps: MamsRouterDeps = {}): void {
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/mams", createMamsRouter(deps));
}
