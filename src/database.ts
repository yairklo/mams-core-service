/**
 * Persistence layer for the MAMS FSM control plane.
 * The only module allowed to touch the Agent* Prisma tables.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import type { AgentRole } from "./actors.js";
import { toPersistedStepView, type PersistedStepView } from "./taskObservability.js";
import { parseTaskState, type StepResult, type TaskId, type TaskState } from "./types.js";

const prisma = new PrismaClient();

export class TaskStatePersistenceError extends Error {
  public override readonly name = "TaskStatePersistenceError";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export class ConcurrentModificationError extends Error {
  public override readonly name = "ConcurrentModificationError";

  constructor(public readonly taskId: string) {
    super(
      `Concurrent write conflict persisting TaskState for task "${taskId}" survived all retries.`
    );
  }
}

export class CorruptedTaskStateError extends Error {
  public override readonly name = "CorruptedTaskStateError";

  constructor(public readonly taskId: string, public readonly validationError: string) {
    super(`Persisted TaskState for task "${taskId}" failed schema validation on load: ${validationError}`);
  }
}

const MAX_SERIALIZATION_RETRIES = 3;
const RETRYABLE_PRISMA_ERROR_CODES: ReadonlySet<string> = new Set(["P2034"]);

function isRetryableSerializationError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && RETRYABLE_PRISMA_ERROR_CODES.has(err.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toJsonValue(state: TaskState): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
}

export async function saveTaskState(state: TaskState): Promise<void> {
  const data = toJsonValue(state);

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const existing = await tx.agentTaskState.findUnique({
            where: { taskId: state.taskId },
            select: { version: true },
          });

          await tx.agentTaskState.upsert({
            where: { taskId: state.taskId },
            create: {
              taskId: state.taskId,
              sessionId: state.sessionId,
              parentTaskId: state.parentTaskId,
              status: state.status,
              version: 1,
              state: data,
            },
            update: {
              sessionId: state.sessionId,
              parentTaskId: state.parentTaskId,
              status: state.status,
              version: (existing?.version ?? 0) + 1,
              state: data,
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 10000,
        }
      );
      return;
    } catch (err) {
      if (isRetryableSerializationError(err)) {
        if (attempt === MAX_SERIALIZATION_RETRIES) {
          throw new ConcurrentModificationError(state.taskId);
        }
        await sleep(25 * attempt + Math.floor(Math.random() * 25));
        continue;
      }
      throw new TaskStatePersistenceError(`Failed to persist TaskState for task "${state.taskId}"`, err);
    }
  }

  throw new TaskStatePersistenceError(
    `Failed to persist TaskState for task "${state.taskId}" after exhausting retries`,
    null
  );
}

export async function loadTaskState(taskId: TaskId): Promise<TaskState | null> {
  const row = await prisma.agentTaskState.findUnique({ where: { taskId } });
  if (!row) {
    return null;
  }

  const parsed = parseTaskState(row.state);
  if (!parsed.ok) {
    throw new CorruptedTaskStateError(taskId, parsed.error);
  }
  return parsed.state;
}

export async function deleteTaskState(taskId: TaskId): Promise<void> {
  await prisma.agentTaskState.deleteMany({ where: { taskId } });
}

export async function loadAllTaskStates(): Promise<TaskState[]> {
  const rows = await prisma.agentTaskState.findMany({
    orderBy: { createdAt: "desc" },
  });
  const states: TaskState[] = [];
  for (const row of rows) {
    try {
      const parsed = parseTaskState(row.state);
      if (parsed.ok) {
        states.push(parsed.state);
      }
    } catch {
      // Skip corrupted
    }
  }
  return states;
}

export async function loadAllStepUsages(): Promise<{ taskId: string; usage: any }[]> {
  const rows = await prisma.agentStepRecord.findMany({
    select: {
      taskId: true,
      usage: true,
    },
  });
  return rows;
}

export async function recordFiscalSpend(costScopeId: string, deltaUsd: number): Promise<number> {
  const row = await prisma.agentCostLedger.upsert({
    where: { costScopeId },
    create: { costScopeId, spentUsd: deltaUsd },
    update: { spentUsd: { increment: deltaUsd } },
  });
  return row.spentUsd;
}

export async function getFiscalSpend(costScopeId: string): Promise<number> {
  const row = await prisma.agentCostLedger.findUnique({ where: { costScopeId } });
  return row?.spentUsd ?? 0;
}

export interface ExecutionLogEntry {
  readonly taskId: string;
  readonly stepId: string;
  readonly agentId: string;
  readonly role: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export async function appendExecutionLog(entry: ExecutionLogEntry): Promise<void> {
  try {
    await prisma.agentExecutionLog.create({ data: entry });
  } catch (err) {
    console.error(`[database] Failed to append execution log for task "${entry.taskId}":`, err);
  }
}

export async function saveStepRecord(
  taskId: TaskId,
  stepIndex: number,
  role: AgentRole,
  step: StepResult
): Promise<PersistedStepView> {
  const createdAt = new Date();
  const view = toPersistedStepView(stepIndex, role, step, createdAt);
  try {
    await prisma.agentStepRecord.upsert({
      where: { taskId_stepId: { taskId, stepId: step.stepId } },
      create: {
        taskId,
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
        })) as Prisma.InputJsonValue,
        usage: JSON.parse(JSON.stringify(step.usage)) as Prisma.InputJsonValue,
        timestampMs: BigInt(step.timestampMs),
      },
      update: {
        stepIndex,
        agentId: step.agentId,
        role,
        narrativeSummary: step.narrativeSummary,
        toolCalls: step.toolCalls.map((call) => ({
          toolName: call.request.toolName,
          args: call.request.args,
          ok: call.result.ok,
          errorMessage: call.result.ok ? null : call.result.message,
        })) as Prisma.InputJsonValue,
        usage: JSON.parse(JSON.stringify(step.usage)) as Prisma.InputJsonValue,
        timestampMs: BigInt(step.timestampMs),
      },
    });
  } catch (err) {
    console.error(`[database] Failed to persist step record for task "${taskId}":`, err);
  }
  return view;
}

export async function loadStepRecords(taskId: TaskId): Promise<readonly PersistedStepView[]> {
  const rows = await prisma.agentStepRecord.findMany({
    where: { taskId },
    orderBy: { stepIndex: "asc" },
  });
  return rows.map((row) => ({
    stepId: row.stepId,
    stepIndex: row.stepIndex,
    agentId: row.agentId,
    role: row.role,
    narrativeSummary: row.narrativeSummary,
    toolCalls: row.toolCalls as unknown as PersistedStepView["toolCalls"],
    usage: row.usage as unknown as StepResult["usage"],
    timestampMs: Number(row.timestampMs),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
