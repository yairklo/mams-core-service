/**
 * The execution plane: specialized agent personas wired to the Vercel AI SDK.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, type LanguageModel } from "ai";

import { resolveGoogleModelId } from "./googleModelResolver.js";
import { estimateTurnCostUsd } from "./pricing.js";
import {
  type AgentId,
  asAgentId,
  computeStepId,
  type ExecutionTier,
  type LlmProvider,
  type LlmRoutingConfig,
  type MamsConfig,
  type PmContext,
  type StepId,
  type StepResult,
  type TaskContract,
  type TaskId,
  type ToolCallRequest,
  type ToolCallResult,
} from "./types.js";
import { createToolSet, PROJECT_RULES_FILENAME, PROJECT_RULES_SECTION_HEADER, readBlueprintStep, resolveSandboxPath } from "./tools.js";

export { PROJECT_RULES_FILENAME, PROJECT_RULES_SECTION_HEADER };

export type AgentRole = "CODER" | "TESTER" | "QA" | "SPEC_REVIEWER" | "SUPERVISOR" | "ARCHITECT";

const HEAVY_ROLES: ReadonlySet<AgentRole> = new Set(["CODER", "SUPERVISOR", "ARCHITECT"]);

const ANTHROPIC_MODEL_BY_TIER = {
  heavy: "claude-3-5-sonnet-20241022",
  light: "claude-3-5-haiku-20241022",
} as const;

const GOOGLE_MODEL_PREFERENCE_BY_TIER = {
  heavy: "gemini-1.5-pro",
  light: "gemini-1.5-flash",
} as const;

const PROMPT_FILENAME_BY_ROLE: Readonly<Record<AgentRole, string>> = {
  CODER: "coder.md",
  TESTER: "tester.md",
  QA: "qa.md",
  SPEC_REVIEWER: "spec_reviewer.md",
  SUPERVISOR: "supervisor.md",
  ARCHITECT: "architect.md",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = (() => {
  const distPrompts = join(__dirname, "prompts");
  if (existsSync(distPrompts)) {
    return distPrompts;
  }
  return join(__dirname, "..", "prompts");
})();

export class MissingPersonaPromptError extends Error {
  public override readonly name = "MissingPersonaPromptError";

  constructor(public readonly role: AgentRole, public readonly filePath: string, cause: unknown) {
    super(`No usable prompt file for persona "${role}" at "${filePath}".`, { cause });
  }
}

const promptCache = new Map<AgentRole, string>();

export function loadPersonaPrompt(role: AgentRole): string {
  const cached = promptCache.get(role);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = join(PROMPTS_DIR, PROMPT_FILENAME_BY_ROLE[role]);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new MissingPersonaPromptError(role, filePath, err);
  }
  if (content.trim().length === 0) {
    throw new MissingPersonaPromptError(role, filePath, new Error("prompt file is empty"));
  }

  promptCache.set(role, content);
  return content;
}

export interface CompiledSystemPrompt {
  readonly system: string;
  readonly projectRulesLoaded: boolean;
}

function logRulesTelemetry(event: string, payload: Record<string, unknown>): void {
  console.warn(`[telemetry] ${JSON.stringify({ event, ...payload })}`);
}

/**
 * Merges the global persona prompt with optional workspace-local `.mams-rules.md`.
 * Project-specific constraints live in the target workspace; personas stay universal.
 */
export async function compileSystemPrompt(
  role: AgentRole,
  sandboxRoot: string,
  taskId?: TaskId
): Promise<CompiledSystemPrompt> {
  const personaPrompt = loadPersonaPrompt(role);

  let rulesAbsolutePath: string;
  try {
    rulesAbsolutePath = resolveSandboxPath(sandboxRoot, PROJECT_RULES_FILENAME);
  } catch (err) {
    logRulesTelemetry("project_rules_path_rejected", {
      taskId,
      role,
      sandboxRoot,
      file: PROJECT_RULES_FILENAME,
      error: err instanceof Error ? err.message : String(err),
    });
    return { system: personaPrompt, projectRulesLoaded: false };
  }

  try {
    const projectRules = await readFile(rulesAbsolutePath, "utf8");
    if (projectRules.trim().length === 0) {
      logRulesTelemetry("project_rules_empty", { taskId, role, sandboxRoot, file: PROJECT_RULES_FILENAME });
      return { system: personaPrompt, projectRulesLoaded: false };
    }

    return {
      system: `${personaPrompt}\n\n${PROJECT_RULES_SECTION_HEADER}\n\n${projectRules.trim()}`,
      projectRulesLoaded: true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logRulesTelemetry("project_rules_missing", { taskId, role, sandboxRoot, file: PROJECT_RULES_FILENAME });
      return { system: personaPrompt, projectRulesLoaded: false };
    }

    logRulesTelemetry("project_rules_read_failed", {
      taskId,
      role,
      sandboxRoot,
      file: PROJECT_RULES_FILENAME,
      error: err instanceof Error ? err.message : String(err),
    });
    return { system: personaPrompt, projectRulesLoaded: false };
  }
}

export function buildToolsForRole(role: AgentRole, sandboxRoot: string) {
  const full = createToolSet(sandboxRoot);
  switch (role) {
    case "CODER":
      return {
        write_file: full.write_file,
        read_file: full.read_file,
        list_changed_files: full.list_changed_files,
        run_local_tests: full.run_local_tests,
      };
    case "ARCHITECT":
      return { write_file: full.write_file, read_file: full.read_file, list_changed_files: full.list_changed_files };
    case "SUPERVISOR":
      return {
        read_file: full.read_file,
        list_changed_files: full.list_changed_files,
        run_local_tests: full.run_local_tests,
        execute_claude_code_escalation: full.execute_claude_code_escalation,
      };
    case "TESTER":
    case "QA":
    case "SPEC_REVIEWER":
      return {
        read_file: full.read_file,
        list_changed_files: full.list_changed_files,
        run_local_tests: full.run_local_tests,
      };
  }
}

export interface AgentTaskContext {
  readonly contract: TaskContract;
  readonly priorSteps: readonly StepResult[];
  readonly sandboxRoot: string;
  readonly pmContext?: PmContext | null;
  /** When set, CODER focuses on this sequential blueprint step from `task-blueprint.md`. */
  readonly blueprintStepIndex?: number;
}

async function buildUserPrompt(role: AgentRole, context: AgentTaskContext): Promise<string> {
  const { contract, priorSteps, pmContext, sandboxRoot, blueprintStepIndex } = context;
  const sections: string[] = [];

  if (pmContext) {
    sections.push(
      [
        "## PM Context (from n8n intake)",
        pmContext.initialRequest ? `Initial request: ${JSON.stringify(pmContext.initialRequest)}` : null,
        pmContext.clarifyingQuestions?.length
          ? `Clarifying questions:\n${pmContext.clarifyingQuestions.map((q) => `- ${q}`).join("\n")}`
          : null,
        pmContext.developerReplies?.length
          ? `Developer replies:\n${pmContext.developerReplies.map((r) => `- ${r}`).join("\n")}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    );
  }

  sections.push(
    [
      "## Task Contract",
      `Objective: ${contract.objective}`,
      "Acceptance Criteria:",
      contract.acceptanceCriteria.length > 0
        ? contract.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
        : "- (none specified)",
    ].join("\n")
  );

  if (role === "ARCHITECT") {
    sections.push(
      [
        "## Context Assessment Deliverables",
        `1. Write or enrich \`${PROJECT_RULES_FILENAME}\` with concrete project rules (no placeholders).`,
        "2. Write `task-blueprint.md` with a numbered, sequential checklist decomposing the objective.",
        "Use read_file to inspect the repo, then write_file for both artifacts.",
      ].join("\n")
    );
  }

  if (role === "CODER" && blueprintStepIndex !== undefined) {
    const step = await readBlueprintStep(sandboxRoot, blueprintStepIndex);
    if (step) {
      sections.push(
        [
          "## Blueprint Step (from task-blueprint.md)",
          `Step ${blueprintStepIndex + 1}: ${step}`,
          "Complete ONLY this step in your turn. Do not skip ahead to later blueprint steps.",
        ].join("\n")
      );
    }
  }

  if (priorSteps.length > 0) {
    const isVerifierRole = role === "TESTER" || role === "QA" || role === "SPEC_REVIEWER";
    const historyLines = priorSteps.map(
      (step, i) => `${i + 1}. [${step.agentId}] ${truncateNarrativeSummary(step.narrativeSummary)}`
    );
    sections.push(
      [
        `## Prior step history (${priorSteps.length})`,
        isVerifierRole
          ? "Narratives below are SELF-REPORTED — verify independently against the Task Contract."
          : null,
        historyLines.join("\n"),
      ]
        .filter((line): line is string => line !== null)
        .join("\n\n")
    );
  }

  return sections.join("\n\n");
}

interface GenericContentPart {
  readonly type: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
}

interface ToolActivity {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
}

function collectToolActivity(steps: readonly { content: readonly GenericContentPart[] }[]): ToolActivity[] {
  const byId = new Map<string, ToolActivity>();
  for (const step of steps) {
    for (const part of step.content) {
      if (!part.toolCallId) continue;
      const existing = byId.get(part.toolCallId);
      if (part.type === "tool-call") {
        byId.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? existing?.toolName ?? "unknown_tool",
          input: part.input,
          output: existing?.output,
          error: existing?.error,
        });
      } else if (part.type === "tool-result") {
        byId.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? existing?.toolName ?? "unknown_tool",
          input: existing?.input ?? part.input,
          output: part.output,
          error: existing?.error,
        });
      } else if (part.type === "tool-error") {
        byId.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? existing?.toolName ?? "unknown_tool",
          input: existing?.input ?? part.input,
          output: existing?.output,
          error: part.error,
        });
      }
    }
  }
  return Array.from(byId.values());
}

function hashArgs(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function toStepResultToolCalls(
  activity: readonly ToolActivity[],
  stepId: StepId,
  requestedBy: AgentId
): readonly { readonly request: ToolCallRequest; readonly result: ToolCallResult }[] {
  return activity.map((a) => ({
    request: {
      stepId,
      toolName: a.toolName,
      args: a.input,
      argsHash: hashArgs(a.input),
      locks: [],
      requestedBy,
    },
    result:
      a.error !== undefined
        ? { ok: false, errorCode: "TOOL_EXECUTION_ERROR", message: describeError(a.error), retriable: true }
        : {
            ok: true,
            output: a.output,
            verifiedReadBack: Boolean((a.output as { verifiedReadBack?: unknown } | undefined)?.verifiedReadBack),
          },
  }));
}

function routingConfigFrom(config: MamsConfig | LlmRoutingConfig): LlmRoutingConfig {
  return {
    preferredProvider: config.preferredProvider ?? "GOOGLE",
    modelOverride: config.modelOverride ?? null,
  };
}

/** Resolves provider + model id for a role using tiered routing rules. */
export async function resolveModelIdForRole(
  role: AgentRole,
  config: MamsConfig | LlmRoutingConfig
): Promise<{ readonly provider: LlmProvider; readonly modelId: string }> {
  const routing = routingConfigFrom(config);
  const provider = routing.preferredProvider ?? "GOOGLE";
  const isHeavy = HEAVY_ROLES.has(role);

  if (provider === "ANTHROPIC") {
    return {
      provider,
      modelId: routing.modelOverride ?? (isHeavy ? ANTHROPIC_MODEL_BY_TIER.heavy : ANTHROPIC_MODEL_BY_TIER.light),
    };
  }

  const preferred =
    routing.modelOverride ?? (isHeavy ? GOOGLE_MODEL_PREFERENCE_BY_TIER.heavy : GOOGLE_MODEL_PREFERENCE_BY_TIER.light);
  const modelId = await resolveGoogleModelId(preferred);
  return { provider, modelId };
}

/** Centralized LLM factory — routes to Anthropic or Google based on config and role tier. */
export async function getLLMModel(role: AgentRole, config: MamsConfig): Promise<LanguageModel> {
  const { provider, modelId } = await resolveModelIdForRole(role, config);
  if (provider === "ANTHROPIC") {
    return anthropic(modelId);
  }
  return google(modelId);
}

/** @deprecated Use resolveModelIdForRole — retained for telemetry callers expecting a model string. */
export async function resolveModelForRole(role: AgentRole, override?: string): Promise<string> {
  return (await resolveModelIdForRole(role, {
    preferredProvider: "GOOGLE",
    modelOverride: override ?? null,
  })).modelId;
}

export interface RunAgentOptions {
  readonly preferredProvider?: LlmProvider;
  readonly modelOverride?: string | null;
  readonly maxToolRoundtrips?: number;
  readonly agentId?: AgentId;
  readonly useSandbox?: boolean;
}

export interface ExecuteAgentTurnOptions extends RunAgentOptions {
  /** Record telemetry/history without dispatching STEP_RESULT (Context Assessment / mid-blueprint). */
  readonly suppressStepTransition?: boolean;
}

const DEFAULT_MAX_TOOL_ROUNDTRIPS = 8;
const MAX_PRIOR_STEP_SUMMARY_CHARS = 2_000;

export function resolveMaxToolRoundtripsForRole(role: AgentRole, executionTier?: ExecutionTier): number {
  switch (role) {
    case "TESTER":
    case "QA":
    case "SPEC_REVIEWER":
      return 5;
    case "ARCHITECT":
    case "SUPERVISOR":
      return 6;
    case "CODER":
      if (executionTier === "TIER3_CRITICAL" || executionTier === "TIER4_ENTERPRISE_E2E") {
        return 12;
      }
      return DEFAULT_MAX_TOOL_ROUNDTRIPS;
    default:
      return DEFAULT_MAX_TOOL_ROUNDTRIPS;
  }
}

export function resolveAgentTurnTimeoutMsForRole(role: AgentRole): number {
  switch (role) {
    case "TESTER":
    case "QA":
    case "SPEC_REVIEWER":
      return 180_000;
    case "CODER":
    case "ARCHITECT":
      return 300_000;
    default:
      return 240_000;
  }
}

function truncateNarrativeSummary(summary: string): string {
  if (summary.length <= MAX_PRIOR_STEP_SUMMARY_CHARS) {
    return summary;
  }
  return `${summary.slice(0, MAX_PRIOR_STEP_SUMMARY_CHARS)}... [truncated ${summary.length - MAX_PRIOR_STEP_SUMMARY_CHARS} chars]`;
}

export async function runAgent(
  role: AgentRole,
  taskId: TaskId,
  stepIndex: number,
  context: AgentTaskContext,
  options: RunAgentOptions = {}
): Promise<StepResult> {
  const startedAt = Date.now();
  const agentId = options.agentId ?? asAgentId(`${role.toLowerCase()}-default`);

  const routingConfig: LlmRoutingConfig = {
    preferredProvider: options.preferredProvider ?? "GOOGLE",
    modelOverride: options.modelOverride ?? null,
  };
  const { provider, modelId } = await resolveModelIdForRole(role, routingConfig);
  const model = provider === "ANTHROPIC" ? anthropic(modelId) : google(modelId);

  const { system } = await compileSystemPrompt(role, context.sandboxRoot, taskId);
  const prompt = await buildUserPrompt(role, context);
  const tools = options.useSandbox === false ? undefined : buildToolsForRole(role, context.sandboxRoot);

  const stepId = computeStepId(taskId, stepIndex, { role, modelId, objective: context.contract.objective });
  const maxToolRoundtrips = options.maxToolRoundtrips ?? resolveMaxToolRoundtripsForRole(role);
  const timeoutMs = resolveAgentTurnTimeoutMsForRole(role);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  let result;
  try {
    result = await generateText({
      model,
      system,
      prompt,
      ...(tools ? { tools } : {}),
      stopWhen: stepCountIs(maxToolRoundtrips),
      abortSignal: abortController.signal,
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new Error(`Agent turn timed out after ${timeoutMs}ms (${role}).`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const activity = collectToolActivity(result.steps);
  const toolCalls = toStepResultToolCalls(activity, stepId, agentId);
  const inputTokens = result.totalUsage.inputTokens ?? 0;
  const outputTokens = result.totalUsage.outputTokens ?? 0;

  return {
    stepId,
    taskId,
    agentId,
    toolCalls,
    producedArtifacts: [],
    narrativeSummary: result.text,
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateTurnCostUsd(modelId, inputTokens, outputTokens),
      provider,
      modelId,
    },
    timestampMs: startedAt,
  };
}
