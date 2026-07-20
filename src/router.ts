/**

 * HTTP router for n8n webhook integration and cloud deployment callbacks.

 */



import { createHash, randomUUID } from "node:crypto";

import { mkdirSync, existsSync, readFileSync } from "node:fs";

import { join } from "node:path";

import express, { type Express, type Request, type Response, type Router } from "express";

import { z } from "zod";



import { StateMachine, type CreateTaskOptions } from "./fsmEngine.js";

import { loadAllStepUsages, loadAllTaskStates, loadStepRecords } from "./database.js";

import { getTaskRuntimeSnapshot, isOrchestrationRunning, runTaskOrchestration, terminateTaskOrchestration } from "./orchestration.js";

import { AGENT_WORKSPACES_BASE_DIR, assertSandboxRootIsContained } from "./tools.js";

import {

  asSessionId,

  asTaskId,

  isTerminalStatus,

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



const ApprovalBodySchema = z.object({
  by: z.string().min(1).default("human"),
  userGuidance: z.string().optional(),
});



const CancelAbortBodySchema = z.object({

  by: z.string().min(1).default("workflow"),

  reason: z.string().optional(),

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



function parseTaskIdParam(rawId: string | string[] | undefined): TaskId | null {

  const taskIdParam = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!taskIdParam) {

    return null;

  }

  return asTaskId(taskIdParam);

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



    void runTaskOrchestration(sm, taskId, sandboxPathForTask(taskId)).catch((err) => {

      console.error(`[router] orchestration crashed for task "${taskId}":`, err);

    });

  });



  router.post("/task/:taskId/resume", async (req: Request, res: Response) => {
    const taskId = parseTaskIdParam(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }
    const parsed = z.object({ userGuidance: z.string().optional() }).safeParse(req.body ?? {});
    const userGuidance = parsed.success ? parsed.data.userGuidance : undefined;

    try {
      let state = await sm.getTaskState(taskId);
      if (isTerminalStatus(state.status)) {
        res.status(409).json({ error: `Task is terminal (${state.status}).` });
        return;
      }
      if (isOrchestrationRunning(taskId)) {
        res.status(409).json({ error: "Orchestration is already running for this task." });
        return;
      }

      if (state.status === "ESCALATED") {
        state = await sm.dispatch(taskId, {
          kind: "APPROVAL_GRANTED",
          by: "human",
          ...(userGuidance ? { userGuidance } : {}),
        });
      }

      res.status(202).json({ taskId, status: state.status, message: "Orchestration resumed." });
      void runTaskOrchestration(sm, taskId, sandboxPathForTask(taskId)).catch((err) => {
        console.error(`[router] resume orchestration failed for "${taskId}":`, err);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(404).json({ error: `Task not found: ${msg}` });
    }
  });



  router.post("/task/:taskId/approve", async (req: Request, res: Response) => {

    const taskId = parseTaskIdParam(req.params.taskId);

    if (!taskId) {

      res.status(400).json({ error: "Missing taskId" });

      return;

    }

    const parsed = ApprovalBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {

      res.status(400).json({ error: parsed.error.toString() });

      return;

    }

    try {

      const current = await sm.getTaskState(taskId);

      if (current.status !== "AWAITING_APPROVAL" && current.status !== "ESCALATED") {

        res.status(409).json({
          error: `Task status is ${current.status}; approve only applies to AWAITING_APPROVAL or ESCALATED.`,
        });

        return;

      }

      if (isOrchestrationRunning(taskId)) {

        res.status(409).json({ error: "Orchestration is already running for this task." });

        return;

      }

      const next = await sm.dispatch(taskId, {
        kind: "APPROVAL_GRANTED",
        by: parsed.data.by,
        ...(parsed.data.userGuidance ? { userGuidance: parsed.data.userGuidance } : {}),
      });

      res.json({ taskId: next.taskId, status: next.status });

      void runTaskOrchestration(sm, taskId, sandboxPathForTask(taskId)).catch((err) => {

        console.error(`[router] post-approve orchestration failed for "${taskId}":`, err);

      });

    } catch (err) {

      const message = err instanceof Error ? err.message : String(err);

      res.status(400).json({ error: message });

    }

  });



  router.post("/task/:taskId/deny", async (req: Request, res: Response) => {

    const taskId = parseTaskIdParam(req.params.taskId);

    if (!taskId) {

      res.status(400).json({ error: "Missing taskId" });

      return;

    }

    const parsed = ApprovalBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {

      res.status(400).json({ error: parsed.error.toString() });

      return;

    }

    try {

      const next = await sm.dispatch(taskId, { kind: "APPROVAL_DENIED", by: parsed.data.by });

      res.json({ taskId: next.taskId, status: next.status });

    } catch (err) {

      const message = err instanceof Error ? err.message : String(err);

      res.status(400).json({ error: message });

    }

  });



  router.post("/task/:taskId/cancel", async (req: Request, res: Response) => {

    const taskId = parseTaskIdParam(req.params.taskId);

    if (!taskId) {

      res.status(400).json({ error: "Missing taskId" });

      return;

    }

    const parsed = CancelAbortBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {

      res.status(400).json({ error: parsed.error.toString() });

      return;

    }

    try {

      const current = await sm.getTaskState(taskId);

      if (isTerminalStatus(current.status)) {

        res.status(409).json({ error: `Task is terminal (${current.status}).` });

        return;

      }

      const next = await terminateTaskOrchestration(

        sm,

        taskId,

        sandboxPathForTask(taskId),

        "cancel",

        parsed.data.by,

        parsed.data.reason

      );

      res.json({ taskId: next.taskId, status: next.status });

    } catch (err) {

      const message = err instanceof Error ? err.message : String(err);

      res.status(400).json({ error: message });

    }

  });



  router.post("/task/:taskId/abort", async (req: Request, res: Response) => {

    const taskId = parseTaskIdParam(req.params.taskId);

    if (!taskId) {

      res.status(400).json({ error: "Missing taskId" });

      return;

    }

    const parsed = CancelAbortBodySchema.safeParse(req.body ?? {});

    if (!parsed.success) {

      res.status(400).json({ error: parsed.error.toString() });

      return;

    }

    try {

      const current = await sm.getTaskState(taskId);

      if (isTerminalStatus(current.status)) {

        res.status(409).json({ error: `Task is terminal (${current.status}).` });

        return;

      }

      const next = await terminateTaskOrchestration(

        sm,

        taskId,

        sandboxPathForTask(taskId),

        "abort",

        parsed.data.by,

        parsed.data.reason

      );

      res.json({ taskId: next.taskId, status: next.status });

    } catch (err) {

      const message = err instanceof Error ? err.message : String(err);

      res.status(400).json({ error: message });

    }

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



  router.get("/tasks", async (req: Request, res: Response) => {
    try {
      const states = await loadAllTaskStates();
      const usages = await loadAllStepUsages();

      const usageMap = new Map<string, { inputTokens: number; outputTokens: number; estimatedCostUsd: number }>();
      for (const row of usages) {
        const usage = row.usage as any;
        if (usage) {
          const current = usageMap.get(row.taskId) ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
          current.inputTokens += Number(usage.inputTokens ?? 0);
          current.outputTokens += Number(usage.outputTokens ?? 0);
          current.estimatedCostUsd += Number(usage.estimatedCostUsd ?? 0);
          usageMap.set(row.taskId, current);
        }
      }

      const list = states.map((state) => {
        const usage = usageMap.get(state.taskId) ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
        return {
          taskId: state.taskId,
          status: state.status,
          executionTier: state.executionTier,
          blueprintStepIndex: state.blueprintStepIndex,
          blueprintTotalSteps: state.blueprintTotalSteps,
          aggregatedTokenUsage: usage,
          orchestrationRunning: isOrchestrationRunning(state.taskId),
        };
      });

      res.json({ tasks: list });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to load tasks: ${message}` });
    }
  });

  function loadBlueprintSteps(tId: string): string[] {
    const blueprintPath = join(AGENT_WORKSPACES_BASE_DIR, tId, "task-blueprint.md");
    if (!existsSync(blueprintPath)) {
      return [];
    }
    try {
      const content = readFileSync(blueprintPath, "utf8");
      const lines = content.split("\n");
      const stepsList: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- [x]") || trimmed.startsWith("- [/]")) {
          const taskText = trimmed.replace(/^-\s*\[[ x\/]\]\s*/i, "").trim();
          if (taskText) stepsList.push(taskText);
        } else if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
          const taskText = trimmed.replace(/^[-*]\s*/, "").trim();
          if (taskText && !taskText.toLowerCase().startsWith("goal") && !taskText.toLowerCase().startsWith("acceptance")) {
            stepsList.push(taskText);
          }
        } else {
          const match = trimmed.match(/^\d+\.\s+(.*)$/);
          if (match && match[1]) {
            stepsList.push(match[1].trim());
          }
        }
      }
      return stepsList;
    } catch {
      return [];
    }
  }

  router.get("/task/:taskId", async (req: Request, res: Response) => {
    const taskId = parseTaskIdParam(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "Missing taskId" });
      return;
    }
    try {
      const state = await sm.getTaskState(taskId);
      const runtime = getTaskRuntimeSnapshot(taskId);
      const steps = await loadStepRecords(taskId);
      const recentTools = steps.flatMap((s) => s.toolCalls.map((tc) => tc.toolName)).slice(-10);
      const liveProgress = {
        percent: state.blueprintTotalSteps > 0 ? Math.round((state.blueprintStepIndex / state.blueprintTotalSteps) * 100) : 0,
        currentStep: state.blueprintStepIndex,
        totalSteps: state.blueprintTotalSteps,
      };

      res.json({
        taskId: state.taskId,
        status: state.status,
        executionTier: state.executionTier,
        history: state.history,
        blueprintStepIndex: state.blueprintStepIndex,
        blueprintTotalSteps: state.blueprintTotalSteps,
        architectureAlignmentStatus: state.architectureAlignmentStatus,
        awaitingApprovalKind: state.awaitingApprovalKind,
        orchestrationRunning: isOrchestrationRunning(taskId),
        steps,
        runtime,
        recentTools,
        liveProgress,
        objective: state.contract.objective,
        acceptanceCriteria: state.contract.acceptanceCriteria,
        createdAt: state.contract.createdAt,
        deadlineMs: state.deadline.absoluteMs,
        sessionId: state.sessionId,
        parentTaskId: state.parentTaskId,
        retry: state.retry,
        optimization: state.optimization,
        preferredProvider: state.preferredProvider,
        modelOverride: state.modelOverride,
        blueprintSteps: loadBlueprintSteps(taskId),
      });
    } catch {
      res.status(404).json({ error: "Task not found" });
    }
  });



  router.get("/task/:taskId/steps", async (req: Request, res: Response) => {

    const taskId = parseTaskIdParam(req.params.taskId);

    if (!taskId) {

      res.status(400).json({ error: "Missing taskId" });

      return;

    }

    try {

      await sm.getTaskState(taskId);

      const steps = await loadStepRecords(taskId);

      res.json({ taskId, steps, orchestrationRunning: isOrchestrationRunning(taskId) });

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

    void runTaskOrchestration(stateMachine, taskId, sandboxPathForTask(taskId)).catch((err) => {

      console.error(`[router] post-cloud orchestration failed for "${taskId}":`, err);

    });

  }



  return { taskId: next.taskId, status: next.status };

}



export { runTaskOrchestration };



export function mountMamsRoutes(app: Express, deps: MamsRouterDeps = {}): void {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  const projectRoot = join(process.cwd());
  app.use("/dashboard", express.static(join(projectRoot, "public", "dashboard")));
  app.get("/admin", (req, res) => {
    res.redirect("/dashboard");
  });
  app.use("/api/mams", createMamsRouter(deps));
}


