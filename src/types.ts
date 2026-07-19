/**
 * Core control-plane types for the Multi-Agent Management System (MAMS).
 *
 * Pure domain modeling plus minimal runtime validation for JSON persisted in
 * PostgreSQL. No runtime dependency on Prisma, Express, or any agent runtime.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

// =====================================================================
// 1. BRANDED IDENTIFIERS
// =====================================================================

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type TaskId = Brand<string, "TaskId">;
export type StepId = Brand<string, "StepId">;
export type AgentId = Brand<string, "AgentId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type LockKey = Brand<string, "LockKey">;

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}
export function asTaskId(value: string): TaskId {
  return value as TaskId;
}
export function asStepId(value: string): StepId {
  return value as StepId;
}
export function asAgentId(value: string): AgentId {
  return value as AgentId;
}
export function asArtifactId(value: string): ArtifactId {
  return value as ArtifactId;
}
export function asLockKey(value: string): LockKey {
  return value as LockKey;
}

export function computeStepId(taskId: TaskId, stepIndex: number, inputPayload: unknown): StepId {
  const canonical = JSON.stringify(canonicalize({ taskId, stepIndex, inputPayload }));
  const hash = createHash("sha256").update(canonical).digest("hex");
  return asStepId(hash);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return entries.reduce<Record<string, unknown>>((acc, [key, val]) => {
      acc[key] = canonicalize(val);
      return acc;
    }, {});
  }
  return value;
}

// =====================================================================
// 2. EXECUTION TIERS — multi-tier execution graph
// =====================================================================

export const EXECUTION_TIERS = [
  /** Trivial tasks (CSS, text). Bypasses PLANNING, TESTER, and sandboxing. */
  "TIER1_FAST_TRACK",
  /** Basic code logic. CODER -> TESTER via local Docker sandbox. No cloud gate. */
  "TIER2_STANDARD",
  /** Critical changes. PLANNING -> SPEC_REVIEW -> CODER -> TESTER -> QA. */
  "TIER3_CRITICAL",
  /** Enterprise E2E. Full chain plus AWAITING_CLOUD_VERIFICATION. */
  "TIER4_ENTERPRISE_E2E",
] as const;

export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

export function isExecutionTier(value: string): value is ExecutionTier {
  return (EXECUTION_TIERS as readonly string[]).includes(value);
}

/** PM context gathered by the n8n PM agent before the task reaches MAMS. */
export interface PmContext {
  readonly initialRequest?: Record<string, unknown>;
  readonly clarifyingQuestions?: readonly string[];
  readonly developerReplies?: readonly string[];
}

export type LlmProvider = "GOOGLE" | "ANTHROPIC";

/** Service-wide defaults injected at StateMachine construction time. */
export interface MamsConfig {
  readonly executionTier: ExecutionTier;
  readonly fiscalBudgetLimitUsd?: number;
  readonly maxStepsPerTask?: number;
  readonly maxRetries?: number;
  readonly maxOptimizations?: number;
  /** When false (TIER1), callers must not mount a Docker sandbox for the task. */
  readonly sandboxEnabled?: boolean;
  /** Default GOOGLE for cost-efficiency; SUPERVISOR may flip per-task via TaskState. */
  readonly preferredProvider?: LlmProvider;
  /** Bypasses role-based model tiering when set. */
  readonly modelOverride?: string | null;
}

/** Subset of MamsConfig used by the LLM routing factory in actors.ts. */
export interface LlmRoutingConfig {
  readonly preferredProvider?: LlmProvider;
  readonly modelOverride?: string | null;
}

export function tierSkipsPlanning(tier: ExecutionTier): boolean {
  return tier === "TIER1_FAST_TRACK" || tier === "TIER2_STANDARD";
}

export function tierNeedsSpecReview(tier: ExecutionTier): boolean {
  return tier === "TIER3_CRITICAL" || tier === "TIER4_ENTERPRISE_E2E";
}

export function tierNeedsSelfCritique(tier: ExecutionTier): boolean {
  return tier === "TIER4_ENTERPRISE_E2E";
}

export function tierNeedsQa(tier: ExecutionTier): boolean {
  return tier === "TIER3_CRITICAL" || tier === "TIER4_ENTERPRISE_E2E";
}

export function tierNeedsCloudVerification(tier: ExecutionTier): boolean {
  return tier === "TIER4_ENTERPRISE_E2E";
}

export function tierUsesSandbox(tier: ExecutionTier): boolean {
  return tier !== "TIER1_FAST_TRACK";
}

/** Cross-stack / multi-file features should run ARCHITECT + blueprint. */
export function tierNeedsArchitectureAlignment(tier: ExecutionTier): boolean {
  return tier === "TIER3_CRITICAL" || tier === "TIER4_ENTERPRISE_E2E";
}

export type ArchitectureAlignmentStatus =
  | "not_required"
  | "required"
  | "ready"
  | "approved";

export type AwaitingApprovalKind = "blueprint" | "qa";

// =====================================================================
// 3. TASK STATUS
// =====================================================================

export const TASK_STATUSES = [
  "PENDING",
  "ARCHITECTING",
  "PLANNING",
  "SPEC_REVIEW",
  "EXECUTING",
  "SELF_CRITIQUE",
  "VERIFYING",
  "OPTIMIZING",
  "AWAITING_APPROVAL",
  /** TIER4 only: waiting for Vercel/Render deployment webhook before final DONE. */
  "AWAITING_CLOUD_VERIFICATION",
  "ESCALATED",
  "DONE",
  "CANCELLED",
  "FAILED",
  "ABORTED_FUSE",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "DONE",
  "CANCELLED",
  "FAILED",
  "ABORTED_FUSE",
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

// =====================================================================
// 4. BUDGETS & CONTRACT
// =====================================================================

export interface RetryBudget {
  readonly attempt: number;
  readonly max: number;
  readonly backoffMs: number;
}

export interface Deadline {
  readonly absoluteMs: number;
  readonly softWarnAtRatio: number;
}

export interface TaskContract {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly groundTruthArtifacts: readonly ArtifactId[];
  readonly createdAt: number;
  readonly immutableHash: string;
}

export interface CloudVerificationRecord {
  readonly provider: string;
  readonly status: "pending" | "success" | "failure";
  readonly errorLogs: string | null;
  readonly receivedAtMs: number | null;
}

// =====================================================================
// 5. TASK STATE
// =====================================================================

export interface TaskState {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly parentTaskId: TaskId | null;
  readonly status: TaskStatus;
  readonly executionTier: ExecutionTier;
  readonly pmContext: PmContext | null;
  readonly assignedAgent: AgentId | null;
  readonly retry: RetryBudget;
  readonly optimization: RetryBudget;
  readonly previousStatus: TaskStatus | null;
  readonly deadline: Deadline;
  readonly contract: TaskContract;
  readonly history: readonly StepId[];
  readonly costScopeId: string;
  readonly cloudVerification: CloudVerificationRecord | null;
  /** Active LLM provider for this task — mutable by SUPERVISOR after optimization. */
  readonly preferredProvider: LlmProvider;
  /** When set, overrides role-based model tiering for all subsequent turns. */
  readonly modelOverride: string | null;
  /** Context Assessment / blueprint orchestration. */
  readonly architectureAlignmentStatus: ArchitectureAlignmentStatus;
  readonly blueprintStepIndex: number;
  readonly blueprintTotalSteps: number;
  readonly awaitingApprovalKind: AwaitingApprovalKind | null;
}

export function nextStepIndex(state: TaskState): number {
  return state.history.length;
}

// =====================================================================
// 6. TOOL EXECUTION & STEP RESULTS
// =====================================================================

export interface ResourceLockManifest {
  readonly resource: LockKey;
  readonly mode: "read" | "write";
}

export interface ToolCallRequest<TArgs = unknown> {
  readonly stepId: StepId;
  readonly toolName: string;
  readonly args: TArgs;
  readonly argsHash: string;
  readonly locks: readonly ResourceLockManifest[];
  readonly requestedBy: AgentId;
}

export type ToolCallResult<TOutput = unknown> =
  | { readonly ok: true; readonly output: TOutput; readonly verifiedReadBack: boolean }
  | { readonly ok: false; readonly errorCode: string; readonly message: string; readonly retriable: boolean };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly provider: LlmProvider;
  readonly modelId: string;
}

export interface StepResult {
  readonly stepId: StepId;
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly toolCalls: readonly { readonly request: ToolCallRequest; readonly result: ToolCallResult }[];
  readonly producedArtifacts: readonly ArtifactId[];
  readonly narrativeSummary: string;
  readonly usage: TokenUsage;
  readonly timestampMs: number;
}

// =====================================================================
// 7. CONTROL-PLANE SIGNALS & TRANSITIONS
// =====================================================================

export type CloudVerificationStatus = "success" | "failure";

export type TaskSignal =
  | { readonly kind: "START" }
  | { readonly kind: "STEP_RESULT"; readonly stepId: StepId; readonly result: StepResult }
  | { readonly kind: "DIVERGENCE_DETECTED"; readonly similarity: number }
  | { readonly kind: "BUDGET_EXCEEDED"; readonly scope: "STEPS" | "TOKENS" | "COST" | "TIME" }
  | { readonly kind: "SOFT_BUDGET_WARNING"; readonly reason: string }
  | { readonly kind: "FUSE_TRIPPED"; readonly reason: string }
  | { readonly kind: "APPROVAL_GRANTED"; readonly by: string }
  | { readonly kind: "APPROVAL_DENIED"; readonly by: string }
  | { readonly kind: "DELIVERABLE_REJECTED"; readonly reason: string }
  | { readonly kind: "ARCHITECTURE_REQUIRED" }
  | { readonly kind: "ARCHITECTURE_ARTIFACTS_READY"; readonly totalSteps: number }
  | { readonly kind: "BLUEPRINT_STEP_ADVANCED"; readonly stepIndex: number; readonly totalSteps: number }
  | { readonly kind: "BLUEPRINT_STEP_RETRY" }
  | { readonly kind: "TASK_CANCELLED"; readonly by: string; readonly reason?: string }
  | { readonly kind: "TASK_ABORTED"; readonly by: string; readonly reason?: string }
  | { readonly kind: "TOOL_CIRCUIT_OPEN"; readonly toolName: string; readonly argsHash: string }
  | {
      readonly kind: "CLOUD_VERIFICATION_RESULT";
      readonly provider: string;
      readonly status: CloudVerificationStatus;
      readonly errorLogs?: string;
    };

export interface Transition {
  readonly from: TaskStatus | "*";
  readonly to: TaskStatus;
  readonly guard: (state: TaskState, signal: TaskSignal) => boolean;
  readonly apply?: (state: TaskState, signal: TaskSignal) => Partial<TaskState>;
}

// =====================================================================
// 8. RUNTIME VALIDATION (Zod)
// =====================================================================

const RetryBudgetSchema = z.object({
  attempt: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  backoffMs: z.number().int().nonnegative(),
});

const DeadlineSchema = z.object({
  absoluteMs: z.number().int().positive(),
  softWarnAtRatio: z.number().min(0).max(1),
});

const TaskContractSchema = z.object({
  taskId: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string()),
  groundTruthArtifacts: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  immutableHash: z.string().min(1),
});

const PmContextSchema = z.object({
  initialRequest: z.record(z.unknown()).optional(),
  clarifyingQuestions: z.array(z.string()).optional(),
  developerReplies: z.array(z.string()).optional(),
});

const CloudVerificationRecordSchema = z.object({
  provider: z.string().min(1),
  status: z.enum(["pending", "success", "failure"]),
  errorLogs: z.string().nullable(),
  receivedAtMs: z.number().int().nullable(),
});

const EXECUTION_TIER_TUPLE = EXECUTION_TIERS as unknown as [ExecutionTier, ...ExecutionTier[]];
const TASK_STATUS_TUPLE = TASK_STATUSES as unknown as [TaskStatus, ...TaskStatus[]];

const TaskStateSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  parentTaskId: z.string().min(1).nullable(),
  status: z.enum(TASK_STATUS_TUPLE),
  executionTier: z.enum(EXECUTION_TIER_TUPLE).default("TIER2_STANDARD"),
  pmContext: PmContextSchema.nullable().default(null),
  assignedAgent: z.string().min(1).nullable(),
  retry: RetryBudgetSchema,
  optimization: RetryBudgetSchema.default({ attempt: 0, max: 2, backoffMs: 0 }),
  previousStatus: z.enum(TASK_STATUS_TUPLE).nullable().default(null),
  deadline: DeadlineSchema,
  contract: TaskContractSchema,
  history: z.array(z.string()),
  costScopeId: z.string().min(1),
  cloudVerification: CloudVerificationRecordSchema.nullable().default(null),
  preferredProvider: z.enum(["GOOGLE", "ANTHROPIC"]).default("GOOGLE"),
  modelOverride: z.string().min(1).nullable().default(null),
  architectureAlignmentStatus: z
    .enum(["not_required", "required", "ready", "approved"])
    .default("not_required"),
  blueprintStepIndex: z.number().int().nonnegative().default(0),
  blueprintTotalSteps: z.number().int().nonnegative().default(0),
  awaitingApprovalKind: z.enum(["blueprint", "qa"]).nullable().default(null),
});

export type TaskStateParseResult =
  | { readonly ok: true; readonly state: TaskState }
  | { readonly ok: false; readonly error: string };

export function parseTaskState(value: unknown): TaskStateParseResult {
  const result = TaskStateSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, error: result.error.toString() };
  }
  return { ok: true, state: result.data as unknown as TaskState };
}
