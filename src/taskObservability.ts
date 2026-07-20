/**
 * In-memory live task progress + persisted step summaries (no extra LLM tokens).
 */

import type { ToolSet } from "ai";
import type { AgentRole } from "./actors.js";
import type { StepResult, TaskId } from "./types.js";

export interface LiveToolEvent {
  readonly toolName: string;
  readonly summary: string;
  readonly atMs: number;
  readonly ok: boolean | null;
}

export interface LiveTaskProgress {
  readonly currentRole: AgentRole | null;
  readonly turnStartedAtMs: number | null;
  readonly lastTool: LiveToolEvent | null;
  readonly recentTools: readonly LiveToolEvent[];
}

export interface PersistedStepToolCallView {
  readonly toolName: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly errorMessage: string | null;
  readonly reasoning?: string | null;
}

export interface PersistedStepView {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly agentId: string;
  readonly role: string;
  readonly narrativeSummary: string;
  readonly toolCalls: readonly PersistedStepToolCallView[];
  readonly usage: StepResult["usage"];
  readonly timestampMs: number;
  readonly createdAt: string;
}

const liveByTask = new Map<TaskId, LiveTaskProgress>();
const MAX_RECENT_TOOLS = 20;

function emptyLiveProgress(): LiveTaskProgress {
  return { currentRole: null, turnStartedAtMs: null, lastTool: null, recentTools: [] };
}

export function getLiveTaskProgress(taskId: TaskId): LiveTaskProgress {
  return liveByTask.get(taskId) ?? emptyLiveProgress();
}

export function clearLiveTaskProgress(taskId: TaskId): void {
  liveByTask.delete(taskId);
}

export function beginAgentTurn(taskId: TaskId, role: AgentRole): void {
  const prev = liveByTask.get(taskId) ?? emptyLiveProgress();
  liveByTask.set(taskId, {
    ...prev,
    currentRole: role,
    turnStartedAtMs: Date.now(),
  });
}

export function endAgentTurn(taskId: TaskId): void {
  const prev = liveByTask.get(taskId);
  if (!prev) {
    return;
  }
  liveByTask.set(taskId, {
    ...prev,
    currentRole: null,
    turnStartedAtMs: null,
  });
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
  if (args === null || args === undefined) {
    return "";
  }
  if (typeof args !== "object") {
    return String(args).slice(0, 120);
  }
  const record = args as Record<string, unknown>;
  switch (toolName) {
    case "write_file":
    case "read_file":
    case "read_file_slice":
      return String(record.path ?? "");
    case "search_files": {
      const query = String(record.query ?? "");
      const prefix = record.pathPrefix ? `@${String(record.pathPrefix)}` : "";
      return `${query}${prefix}`.slice(0, 160);
    }
    case "run_local_tests": {
      const command = String(record.command ?? "");
      const cmdArgs = Array.isArray(record.args) ? record.args.join(" ") : "";
      const cwd = record.cwd ? ` (cwd=${String(record.cwd)})` : "";
      return `${command} ${cmdArgs}${cwd}`.trim().slice(0, 160);
    }
    case "execute_claude_code_escalation":
      return String(record.instructions ?? "").slice(0, 120);
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

export function recordToolCallStart(taskId: TaskId, role: AgentRole, toolName: string, args: unknown): void {
  const summary = summarizeToolArgs(toolName, args);
  const event: LiveToolEvent = { toolName, summary, atMs: Date.now(), ok: null };
  const prev = liveByTask.get(taskId) ?? emptyLiveProgress();
  const recentTools = [...prev.recentTools, event].slice(-MAX_RECENT_TOOLS);
  liveByTask.set(taskId, {
    currentRole: role,
    turnStartedAtMs: prev.turnStartedAtMs ?? Date.now(),
    lastTool: event,
    recentTools,
  });
  console.log(`[task-progress] task="${taskId}" role=${role} tool=${toolName}${summary ? ` ${summary}` : ""}`);
}

export function recordToolCallEnd(taskId: TaskId, toolName: string, ok: boolean): void {
  const prev = liveByTask.get(taskId);
  if (!prev?.lastTool || prev.lastTool.toolName !== toolName) {
    return;
  }
  const updatedLast: LiveToolEvent = { ...prev.lastTool, ok };
  const recentTools = prev.recentTools.map((entry, index) =>
    index === prev.recentTools.length - 1 && entry.toolName === toolName ? updatedLast : entry
  );
  liveByTask.set(taskId, { ...prev, lastTool: updatedLast, recentTools });
}

export function toPersistedStepView(
  stepIndex: number,
  role: AgentRole,
  step: StepResult,
  createdAt: Date
): PersistedStepView {
  return {
    stepId: step.stepId,
    stepIndex,
    agentId: step.agentId,
    role,
    narrativeSummary: step.narrativeSummary,
    toolCalls: step.toolCalls.map((call) => ({
      toolName: call.request.toolName,
      args: call.request.args,
      ok: call.result.ok,
      errorMessage: call.result.ok ? null : call.result.message,
      reasoning: call.request.reasoning ?? null,
    })),
    usage: step.usage,
    timestampMs: step.timestampMs,
    createdAt: createdAt.toISOString(),
  };
}

/** Wraps tool executors to emit live progress logs (zero LLM cost). */
export function wrapToolsForTaskProgress(taskId: TaskId, role: AgentRole, tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    if (!original || typeof original.execute !== "function") {
      wrapped[name] = original;
      continue;
    }
    const execute = original.execute.bind(original);
    wrapped[name] = {
      ...original,
      execute: async (input, options) => {
        recordToolCallStart(taskId, role, name, input);
        try {
          const result = await execute(input, options);
          recordToolCallEnd(taskId, name, true);
          return result;
        } catch (err) {
          recordToolCallEnd(taskId, name, false);
          throw err;
        }
      },
    };
  }
  return wrapped;
}

export function logCompletedStepTools(taskId: TaskId, role: AgentRole, step: StepResult): void {
  if (step.toolCalls.length === 0) {
    console.log(`[task-progress] task="${taskId}" role=${role} step=${step.stepId.slice(0, 12)}… (no tools)`);
    return;
  }
  for (const call of step.toolCalls) {
    const summary = summarizeToolArgs(call.request.toolName, call.request.args);
    const status = call.result.ok ? "ok" : "fail";
    console.log(
      `[task-progress] task="${taskId}" role=${role} step_done tool=${call.request.toolName} status=${status}${summary ? ` ${summary}` : ""}`
    );
  }
}
