/**
 * Deterministic FSM control plane for MAMS.
 * Tier-aware transition routing is the single source of truth for execution graphs.
 */

import { type AgentRole, type AgentTaskContext, type RunAgentOptions, resolveModelIdForRole, runAgent } from "./actors.js";
import { appendExecutionLog, getFiscalSpend, loadTaskState, recordFiscalSpend, saveTaskState } from "./database.js";
import { estimateTurnCostUsd } from "./pricing.js";
import {
  isTerminalStatus,
  nextStepIndex,
  tierNeedsCloudVerification,
  tierNeedsQa,
  tierNeedsSelfCritique,
  tierNeedsSpecReview,
  tierSkipsPlanning,
  tierUsesSandbox,
  type Deadline,
  type ExecutionTier,
  type LlmProvider,
  type PmContext,
  type StepResult,
  type TaskContract,
  type TaskId,
  type TaskSignal,
  type TaskState,
  type TaskStatus,
  type Transition,
} from "./types.js";

export class UnknownTaskError extends Error {
  public override readonly name = "UnknownTaskError";
  constructor(public readonly taskId: string) {
    super(`No persisted TaskState found for task "${taskId}".`);
  }
}

export class InvalidTransitionError extends Error {
  public override readonly name = "InvalidTransitionError";
  constructor(public readonly from: TaskStatus, public readonly signalKind: string) {
    super(`No legal transition from status "${from}" for signal "${signalKind}".`);
  }
}

export class TaskAlreadyExistsError extends Error {
  public override readonly name = "TaskAlreadyExistsError";
  constructor(public readonly taskId: string) {
    super(`Task "${taskId}" already exists.`);
  }
}

export interface FuseStatus {
  readonly blown: boolean;
  readonly reason: string | null;
}

export interface FuseGuard {
  isBlown(costScopeId: string): Promise<FuseStatus>;
  trip(costScopeId: string, reason: string): Promise<void>;
  reset(costScopeId: string): Promise<void>;
}

export class InMemoryFuseGuard implements FuseGuard {
  private readonly blownScopes = new Map<string, string>();

  async isBlown(costScopeId: string): Promise<FuseStatus> {
    const reason = this.blownScopes.get(costScopeId);
    return reason === undefined ? { blown: false, reason: null } : { blown: true, reason };
  }

  async trip(costScopeId: string, reason: string): Promise<void> {
    if (!this.blownScopes.has(costScopeId)) {
      this.blownScopes.set(costScopeId, reason);
    }
  }

  async reset(costScopeId: string): Promise<void> {
    this.blownScopes.delete(costScopeId);
  }
}

export interface FiscalBudgetSnapshot {
  readonly limitUsd: number;
  readonly spentUsd: number;
}

export interface FiscalBudgetLedger {
  getBudget(costScopeId: string): Promise<FiscalBudgetSnapshot>;
  recordSpend(costScopeId: string, deltaUsd: number): Promise<FiscalBudgetSnapshot>;
}

export class PrismaFiscalBudgetLedger implements FiscalBudgetLedger {
  constructor(private readonly limitUsd: number = 10) {}

  async getBudget(costScopeId: string): Promise<FiscalBudgetSnapshot> {
    return { limitUsd: this.limitUsd, spentUsd: await getFiscalSpend(costScopeId) };
  }

  async recordSpend(costScopeId: string, deltaUsd: number): Promise<FiscalBudgetSnapshot> {
    const spentUsd = await recordFiscalSpend(costScopeId, deltaUsd);
    return { limitUsd: this.limitUsd, spentUsd };
  }
}

export interface TokenSpanAttributes {
  readonly taskId: string;
  readonly stepId: string;
  readonly agentId: string;
  readonly role: string;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly "gen_ai.usage.input_tokens": number;
  readonly "gen_ai.usage.output_tokens": number;
  readonly "gen_ai.request.model": string;
  readonly costUsd: number;
}

export interface TelemetrySink {
  recordSpan(attributes: TokenSpanAttributes): Promise<void>;
}

export class PrismaTelemetrySink implements TelemetrySink {
  async recordSpan(attributes: TokenSpanAttributes): Promise<void> {
    console.log(`[telemetry] ${JSON.stringify(attributes)}`);
    await appendExecutionLog({
      taskId: attributes.taskId,
      stepId: attributes.stepId,
      agentId: attributes.agentId,
      role: attributes.role,
      model: attributes.model,
      inputTokens: attributes["gen_ai.usage.input_tokens"],
      outputTokens: attributes["gen_ai.usage.output_tokens"],
      costUsd: attributes.costUsd,
    });
  }
}

class KeyedAsyncMutex<K> {
  private readonly locks = new Map<K, { tail: Promise<void>; waiters: number }>();

  async runExclusive<T>(key: K, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), waiters: 0 };
      this.locks.set(key, entry);
    }
    entry.waiters += 1;
    const previousTail = entry.tail;
    let release!: () => void;
    const nextTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.tail = nextTail;
    await previousTail;
    try {
      return await fn();
    } finally {
      release();
      entry.waiters -= 1;
      if (entry.waiters === 0 && this.locks.get(key) === entry) {
        this.locks.delete(key);
      }
    }
  }
}

function isStepResultSuccessful(result: StepResult): boolean {
  return result.toolCalls.every((call) => call.result.ok);
}

const OPTIMIZABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "PLANNING",
  "SPEC_REVIEW",
  "EXECUTING",
  "SELF_CRITIQUE",
  "VERIFYING",
]);

/** After a successful SUPERVISOR optimization, escalate from GOOGLE to ANTHROPIC for quality. */
function providerSwitchAfterOptimization(state: TaskState): Partial<TaskState> {
  if (state.preferredProvider === "GOOGLE") {
    console.log(
      `[fsmEngine] Switching LLM provider GOOGLE → ANTHROPIC after optimization for task "${state.taskId}".`
    );
    return { preferredProvider: "ANTHROPIC" };
  }
  return {};
}

const TRANSITION_TABLE: readonly Transition[] = [
  { from: "*", to: "ABORTED_FUSE", guard: (_s, signal) => signal.kind === "FUSE_TRIPPED" },
  {
    from: "*",
    to: "ESCALATED",
    guard: (state, signal) => signal.kind === "BUDGET_EXCEEDED" && state.status !== "ESCALATED",
  },
  {
    from: "*",
    to: "OPTIMIZING",
    guard: (state, signal) =>
      signal.kind === "SOFT_BUDGET_WARNING" &&
      OPTIMIZABLE_STATUSES.has(state.status) &&
      state.optimization.attempt < state.optimization.max,
    apply: (state) => ({
      previousStatus: state.status,
      optimization: { ...state.optimization, attempt: state.optimization.attempt + 1 },
    }),
  },

  // --- PENDING: tier-routed START ---
  {
    from: "PENDING",
    to: "EXECUTING",
    guard: (state, signal) => signal.kind === "START" && tierSkipsPlanning(state.executionTier),
  },
  {
    from: "PENDING",
    to: "PLANNING",
    guard: (state, signal) => signal.kind === "START" && !tierSkipsPlanning(state.executionTier),
  },

  // --- PLANNING (TIER3/4) ---
  {
    from: "PLANNING",
    to: "SPEC_REVIEW",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      tierNeedsSpecReview(state.executionTier),
  },
  {
    from: "PLANNING",
    to: "EXECUTING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      !tierNeedsSpecReview(state.executionTier),
  },
  {
    from: "PLANNING",
    to: "ESCALATED",
    guard: (_state, signal) => signal.kind === "STEP_RESULT" && !isStepResultSuccessful(signal.result),
  },

  // --- SPEC_REVIEW (TIER3/4) ---
  {
    from: "SPEC_REVIEW",
    to: "EXECUTING",
    guard: (_state, signal) => signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result),
  },
  {
    from: "SPEC_REVIEW",
    to: "ESCALATED",
    guard: (_state, signal) => signal.kind === "STEP_RESULT" && !isStepResultSuccessful(signal.result),
  },

  // --- EXECUTING: tier-routed exit ---
  {
    from: "EXECUTING",
    to: "DONE",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      state.executionTier === "TIER1_FAST_TRACK",
  },
  {
    from: "EXECUTING",
    to: "SELF_CRITIQUE",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      tierNeedsSelfCritique(state.executionTier),
  },
  {
    from: "EXECUTING",
    to: "VERIFYING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      !tierNeedsSelfCritique(state.executionTier) &&
      state.executionTier !== "TIER1_FAST_TRACK",
  },
  {
    from: "EXECUTING",
    to: "ESCALATED",
    guard: (state, signal) =>
      signal.kind === "TOOL_CIRCUIT_OPEN" ||
      (signal.kind === "STEP_RESULT" && !isStepResultSuccessful(signal.result)),
  },

  // --- SELF_CRITIQUE (TIER4) ---
  {
    from: "SELF_CRITIQUE",
    to: "VERIFYING",
    guard: (_state, signal) => signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result),
  },
  {
    from: "SELF_CRITIQUE",
    to: "EXECUTING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      !isStepResultSuccessful(signal.result) &&
      state.retry.attempt < state.retry.max,
    apply: (state) => ({ retry: { ...state.retry, attempt: state.retry.attempt + 1 } }),
  },
  {
    from: "SELF_CRITIQUE",
    to: "ESCALATED",
    guard: (state, signal) =>
      (signal.kind === "STEP_RESULT" &&
        !isStepResultSuccessful(signal.result) &&
        state.retry.attempt >= state.retry.max) ||
      signal.kind === "DIVERGENCE_DETECTED",
  },

  // --- VERIFYING (TESTER) ---
  {
    from: "VERIFYING",
    to: "DONE",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      state.executionTier === "TIER2_STANDARD",
  },
  {
    from: "VERIFYING",
    to: "AWAITING_APPROVAL",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      tierNeedsQa(state.executionTier),
  },
  {
    from: "VERIFYING",
    to: "SELF_CRITIQUE",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      !isStepResultSuccessful(signal.result) &&
      state.retry.attempt < state.retry.max,
    apply: (state) => ({ retry: { ...state.retry, attempt: state.retry.attempt + 1 } }),
  },
  {
    from: "VERIFYING",
    to: "OPTIMIZING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      !isStepResultSuccessful(signal.result) &&
      state.retry.attempt >= state.retry.max &&
      state.optimization.attempt < state.optimization.max,
    apply: (state) => ({
      previousStatus: "VERIFYING",
      optimization: { ...state.optimization, attempt: state.optimization.attempt + 1 },
    }),
  },
  {
    from: "VERIFYING",
    to: "ESCALATED",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      !isStepResultSuccessful(signal.result) &&
      state.retry.attempt >= state.retry.max &&
      state.optimization.attempt >= state.optimization.max,
  },

  // --- OPTIMIZING (SUPERVISOR) ---
  {
    from: "OPTIMIZING",
    to: "PLANNING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result) && state.previousStatus === "PLANNING",
    apply: (state) => providerSwitchAfterOptimization(state),
  },
  {
    from: "OPTIMIZING",
    to: "SPEC_REVIEW",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result) && state.previousStatus === "SPEC_REVIEW",
    apply: (state) => providerSwitchAfterOptimization(state),
  },
  {
    from: "OPTIMIZING",
    to: "EXECUTING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result) && state.previousStatus === "EXECUTING",
    apply: (state) => providerSwitchAfterOptimization(state),
  },
  {
    from: "OPTIMIZING",
    to: "SELF_CRITIQUE",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result) && state.previousStatus === "SELF_CRITIQUE",
    apply: (state) => providerSwitchAfterOptimization(state),
  },
  {
    from: "OPTIMIZING",
    to: "VERIFYING",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" && isStepResultSuccessful(signal.result) && state.previousStatus === "VERIFYING",
    apply: (state) => providerSwitchAfterOptimization(state),
  },
  { from: "OPTIMIZING", to: "ESCALATED", guard: (_state, signal) => signal.kind === "STEP_RESULT" },

  // --- AWAITING_APPROVAL (QA for TIER3/4) ---
  {
    from: "AWAITING_APPROVAL",
    to: "AWAITING_CLOUD_VERIFICATION",
    guard: (state, signal) =>
      signal.kind === "STEP_RESULT" &&
      isStepResultSuccessful(signal.result) &&
      tierNeedsCloudVerification(state.executionTier),
    apply: (state) => ({
      cloudVerification: {
        provider: "pending",
        status: "pending",
        errorLogs: null,
        receivedAtMs: null,
      },
    }),
  },
  {
    from: "AWAITING_APPROVAL",
    to: "DONE",
    guard: (state, signal) =>
      (signal.kind === "STEP_RESULT" &&
        isStepResultSuccessful(signal.result) &&
        tierNeedsQa(state.executionTier) &&
        !tierNeedsCloudVerification(state.executionTier)) ||
      signal.kind === "APPROVAL_GRANTED",
  },
  {
    from: "AWAITING_APPROVAL",
    to: "ESCALATED",
    guard: (state, signal) =>
      (signal.kind === "STEP_RESULT" && !isStepResultSuccessful(signal.result)) ||
      signal.kind === "APPROVAL_DENIED",
  },

  // --- AWAITING_CLOUD_VERIFICATION (TIER4) ---
  {
    from: "AWAITING_CLOUD_VERIFICATION",
    to: "DONE",
    guard: (_state, signal) => signal.kind === "CLOUD_VERIFICATION_RESULT" && signal.status === "success",
    apply: (state, signal) =>
      signal.kind === "CLOUD_VERIFICATION_RESULT"
        ? {
            cloudVerification: {
              provider: signal.provider,
              status: "success",
              errorLogs: signal.errorLogs ?? null,
              receivedAtMs: Date.now(),
            },
          }
        : {},
  },
  {
    from: "AWAITING_CLOUD_VERIFICATION",
    to: "ESCALATED",
    guard: (_state, signal) => signal.kind === "CLOUD_VERIFICATION_RESULT" && signal.status === "failure",
    apply: (state, signal) =>
      signal.kind === "CLOUD_VERIFICATION_RESULT"
        ? {
            cloudVerification: {
              provider: signal.provider,
              status: "failure",
              errorLogs: signal.errorLogs ?? null,
              receivedAtMs: Date.now(),
            },
          }
        : {},
  },

  // --- ESCALATED ---
  {
    from: "ESCALATED",
    to: "PLANNING",
    guard: (state, signal) => signal.kind === "APPROVAL_GRANTED" && !tierSkipsPlanning(state.executionTier),
    apply: (state) => ({
      retry: { ...state.retry, attempt: 0 },
      optimization: { ...state.optimization, attempt: 0 },
      previousStatus: null,
    }),
  },
  {
    from: "ESCALATED",
    to: "EXECUTING",
    guard: (state, signal) => signal.kind === "APPROVAL_GRANTED" && tierSkipsPlanning(state.executionTier),
    apply: (state) => ({
      retry: { ...state.retry, attempt: 0 },
      optimization: { ...state.optimization, attempt: 0 },
      previousStatus: null,
    }),
  },
  { from: "ESCALATED", to: "FAILED", guard: (_state, signal) => signal.kind === "APPROVAL_DENIED" },
];

function findTransition(state: TaskState, signal: TaskSignal): Transition | undefined {
  return TRANSITION_TABLE.find((t) => (t.from === state.status || t.from === "*") && t.guard(state, signal));
}

export interface CreateTaskOptions {
  readonly taskId: TaskId;
  readonly sessionId: TaskState["sessionId"];
  readonly parentTaskId?: TaskId | null;
  readonly contract: TaskContract;
  readonly costScopeId: string;
  readonly deadline: Deadline;
  readonly executionTier: ExecutionTier;
  readonly pmContext?: PmContext | null;
  readonly maxRetries?: number;
  readonly maxOptimizations?: number;
  readonly preferredProvider?: LlmProvider;
  readonly modelOverride?: string | null;
}

const DEFAULT_MAX_OPTIMIZATIONS = 2;

export function createInitialTaskState(options: CreateTaskOptions): TaskState {
  return {
    taskId: options.taskId,
    sessionId: options.sessionId,
    parentTaskId: options.parentTaskId ?? null,
    status: "PENDING",
    executionTier: options.executionTier,
    pmContext: options.pmContext ?? null,
    assignedAgent: null,
    retry: { attempt: 0, max: options.maxRetries ?? 5, backoffMs: 0 },
    optimization: { attempt: 0, max: options.maxOptimizations ?? DEFAULT_MAX_OPTIMIZATIONS, backoffMs: 0 },
    previousStatus: null,
    deadline: options.deadline,
    contract: options.contract,
    history: [],
    costScopeId: options.costScopeId,
    cloudVerification: null,
    preferredProvider: options.preferredProvider ?? "GOOGLE",
    modelOverride: options.modelOverride ?? null,
  };
}

export interface StateMachineDeps {
  readonly fuseGuard?: FuseGuard;
  readonly fiscalBudgetLedger?: FiscalBudgetLedger;
  readonly telemetrySink?: TelemetrySink;
  readonly now?: () => number;
  readonly maxStepsPerTask?: number;
}

const DEFAULT_MAX_STEPS_PER_TASK = 200;

/** Maps FSM status + tier to the agent persona the orchestrator should invoke. */
export function resolveAgentRoleForStatus(state: TaskState): AgentRole | null {
  switch (state.status) {
    case "PLANNING":
    case "EXECUTING":
    case "SELF_CRITIQUE":
      return "CODER";
    case "SPEC_REVIEW":
      return "SPEC_REVIEWER";
    case "VERIFYING":
      return "TESTER";
    case "AWAITING_APPROVAL":
      return tierNeedsQa(state.executionTier) ? "QA" : null;
    case "OPTIMIZING":
      return "SUPERVISOR";
    default:
      return null;
  }
}

export class StateMachine {
  private readonly fuseGuard: FuseGuard;
  private readonly fiscalBudgetLedger: FiscalBudgetLedger;
  private readonly telemetrySink: TelemetrySink;
  private readonly now: () => number;
  private readonly maxStepsPerTask: number;
  private readonly mutex = new KeyedAsyncMutex<TaskId>();

  constructor(deps: StateMachineDeps = {}) {
    this.fuseGuard = deps.fuseGuard ?? new InMemoryFuseGuard();
    this.fiscalBudgetLedger = deps.fiscalBudgetLedger ?? new PrismaFiscalBudgetLedger();
    this.telemetrySink = deps.telemetrySink ?? new PrismaTelemetrySink();
    this.now = deps.now ?? (() => Date.now());
    this.maxStepsPerTask = deps.maxStepsPerTask ?? DEFAULT_MAX_STEPS_PER_TASK;
  }

  async createTask(options: CreateTaskOptions): Promise<TaskState> {
    return this.mutex.runExclusive(options.taskId, async () => {
      const existing = await loadTaskState(options.taskId);
      if (existing) throw new TaskAlreadyExistsError(options.taskId);
      const initial = createInitialTaskState(options);
      await saveTaskState(initial);
      return this.applySignal(initial, { kind: "START" });
    });
  }

  async getTaskState(taskId: TaskId): Promise<TaskState> {
    const state = await loadTaskState(taskId);
    if (!state) throw new UnknownTaskError(taskId);
    return state;
  }

  async dispatch(taskId: TaskId, signal: TaskSignal): Promise<TaskState> {
    return this.mutex.runExclusive(taskId, async () => {
      const current = await loadTaskState(taskId);
      if (!current) throw new UnknownTaskError(taskId);
      return this.applySignal(current, signal);
    });
  }

  async executeAgentTurn(
    taskId: TaskId,
    role: AgentRole,
    sandboxRoot: string,
    priorSteps: readonly StepResult[] = [],
    options: RunAgentOptions = {}
  ): Promise<TaskState> {
    const state = await this.getTaskState(taskId);
    const stepIndex = nextStepIndex(state);
    const { modelId, provider } = await resolveModelIdForRole(role, {
      preferredProvider: options.preferredProvider ?? state.preferredProvider,
      modelOverride: options.modelOverride ?? state.modelOverride,
    });
    const useSandbox = tierUsesSandbox(state.executionTier);

    const context: AgentTaskContext = {
      contract: state.contract,
      priorSteps,
      sandboxRoot,
      pmContext: state.pmContext,
    };

    const result = await runAgent(role, taskId, stepIndex, context, {
      preferredProvider: state.preferredProvider,
      modelOverride: state.modelOverride,
      useSandbox,
      ...(options.maxToolRoundtrips !== undefined ? { maxToolRoundtrips: options.maxToolRoundtrips } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    });

    const turnCostUsd = estimateTurnCostUsd(modelId, result.usage.inputTokens, result.usage.outputTokens);
    const budget = await this.fiscalBudgetLedger.recordSpend(state.costScopeId, turnCostUsd);

    await this.telemetrySink.recordSpan({
      taskId: state.taskId,
      stepId: result.stepId,
      agentId: result.agentId,
      role,
      provider: result.usage.provider ?? provider,
      model: modelId,
      "gen_ai.usage.input_tokens": result.usage.inputTokens,
      "gen_ai.usage.output_tokens": result.usage.outputTokens,
      "gen_ai.request.model": modelId,
      costUsd: turnCostUsd,
    });

    if (budget.spentUsd >= budget.limitUsd) {
      await this.fuseGuard.trip(
        state.costScopeId,
        `Fiscal budget breached: $${budget.spentUsd.toFixed(4)} of $${budget.limitUsd.toFixed(2)}.`
      );
    }

    return this.dispatch(taskId, { kind: "STEP_RESULT", stepId: result.stepId, result });
  }

  private async checkHardStops(state: TaskState): Promise<TaskSignal | null> {
    const fuseStatus = await this.fuseGuard.isBlown(state.costScopeId);
    if (fuseStatus.blown) {
      return { kind: "FUSE_TRIPPED", reason: fuseStatus.reason ?? "Fuse tripped" };
    }
    if (this.now() > state.deadline.absoluteMs) {
      return { kind: "BUDGET_EXCEEDED", scope: "TIME" };
    }
    if (state.history.length >= this.maxStepsPerTask) {
      return { kind: "BUDGET_EXCEEDED", scope: "STEPS" };
    }
    if (
      OPTIMIZABLE_STATUSES.has(state.status) &&
      state.optimization.attempt < state.optimization.max &&
      this.isPastSoftDeadline(state)
    ) {
      return {
        kind: "SOFT_BUDGET_WARNING",
        reason: `Past ${Math.round(state.deadline.softWarnAtRatio * 100)}% of time budget.`,
      };
    }
    return null;
  }

  private isPastSoftDeadline(state: TaskState): boolean {
    const totalMs = state.deadline.absoluteMs - state.contract.createdAt;
    if (totalMs <= 0) return false;
    return this.now() >= state.contract.createdAt + totalMs * state.deadline.softWarnAtRatio;
  }

  private recordStep(state: TaskState, signal: TaskSignal): TaskState {
    if (signal.kind !== "STEP_RESULT") return state;
    if (state.history.includes(signal.stepId)) return state;
    return { ...state, history: [...state.history, signal.stepId] };
  }

  private async applySignal(current: TaskState, signal: TaskSignal): Promise<TaskState> {
    if (isTerminalStatus(current.status)) {
      console.warn(`[fsmEngine] Ignoring signal "${signal.kind}" — terminal (${current.status}).`);
      return current;
    }

    if (signal.kind === "STEP_RESULT" && current.history.includes(signal.stepId)) {
      console.warn(`[fsmEngine] Ignoring stale replay of stepId "${signal.stepId}".`);
      return current;
    }

    const forcedSignal = await this.checkHardStops(current);
    const effectiveSignal = forcedSignal ?? signal;
    const bookkept = this.recordStep(current, effectiveSignal);
    const transition = findTransition(bookkept, effectiveSignal);

    if (!transition) {
      if (forcedSignal) {
        console.warn(`[fsmEngine] Hard-stop "${forcedSignal.kind}" deferred at "${current.status}".`);
        return current;
      }
      throw new InvalidTransitionError(current.status, signal.kind);
    }

    const patch = transition.apply?.(bookkept, effectiveSignal) ?? {};
    const next: TaskState = { ...bookkept, ...patch, status: transition.to };
    await saveTaskState(next);
    return next;
  }
}

export { TRANSITION_TABLE };
