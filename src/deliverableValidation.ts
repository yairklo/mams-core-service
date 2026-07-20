/**
 * Programmatic quality gates for agent deliverables (no LLM).
 */

import type { StepResult } from "./types.js";
import {
  collectWorkspaceChanges,
  filterMeaningfulPaths,
  hasMeaningfulSourceChanges,
  type GitProcessRunner,
} from "./workspaceGit.js";

export interface DeliverableValidationResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly meaningfulPaths: readonly string[];
}

function countSuccessfulToolCalls(result: StepResult, toolName: string): number {
  return result.toolCalls.filter((call) => call.request.toolName === toolName && call.result.ok).length;
}

const BLUEPRINT_VERIFY_STEP_PATTERNS: readonly RegExp[] = [
  /^run\s+/i,
  /\brun\s+`?(npx|npm|yarn|pnpm)\b/i,
  /\b(final verification|verification\s*&\s*tests?|verify)\b/i,
  /\b(npm test|run tests?|lint|typecheck|type-check|db push|prisma (?:format|generate|migrate))\b/i,
];

/** True when a blueprint step is verification-only (commands/tests, no new code required). */
export function isBlueprintVerifyStep(blueprintStepText: string | null | undefined): boolean {
  if (!blueprintStepText?.trim()) {
    return false;
  }
  const text = blueprintStepText.trim();
  if (/\b(update|implement|add|create|write|modify|ensure there is|build|extend)\b/i.test(text)) {
    return false;
  }
  return BLUEPRINT_VERIFY_STEP_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateCoderStepResult(
  result: StepResult,
  blueprintStepText?: string | null
): DeliverableValidationResult {
  const writeCount = countSuccessfulToolCalls(result, "write_file");
  const testCount = countSuccessfulToolCalls(result, "run_local_tests");

  if (isBlueprintVerifyStep(blueprintStepText ?? null)) {
    if (testCount > 0 || writeCount > 0) {
      return { ok: true, reason: "coder_verify_step_ok", meaningfulPaths: [] };
    }
    return {
      ok: false,
      reason:
        "Verify blueprint step requires run_local_tests (passing) or write_file if code changes are needed.",
      meaningfulPaths: [],
    };
  }

  if (writeCount === 0) {
    return {
      ok: false,
      reason: "CODER completed without any successful write_file calls.",
      meaningfulPaths: [],
    };
  }

  const productWrites = result.toolCalls.filter((call) => {
    if (call.request.toolName !== "write_file" || !call.result.ok) return false;
    const path = (call.request.args as { path?: string }).path ?? "";
    return /^(server|mobile_app|next_app)\//.test(path.replace(/\\/g, "/"));
  });
  if (!isBlueprintVerifyStep(blueprintStepText ?? null) && productWrites.length === 0) {
    return {
      ok: false,
      reason: "CODER write_file must target product paths under server/, mobile_app/, or next_app/.",
      meaningfulPaths: [],
    };
  }
  return { ok: true, reason: "coder_tool_calls_ok", meaningfulPaths: [] };
}

export async function validateCoderWorkspaceChanges(
  runGit: GitProcessRunner
): Promise<DeliverableValidationResult> {
  const changes = await collectWorkspaceChanges(runGit);
  if (!hasMeaningfulSourceChanges(changes.allPaths)) {
    return {
      ok: false,
      reason: "No meaningful product source changes detected (only lockfiles, docs, or noise).",
      meaningfulPaths: changes.meaningfulPaths,
    };
  }
  return {
    ok: true,
    reason: "meaningful_changes_present",
    meaningfulPaths: changes.meaningfulPaths,
  };
}

export async function validateCoderDeliverable(
  result: StepResult,
  runGit: GitProcessRunner,
  blueprintStepText?: string | null
): Promise<DeliverableValidationResult> {
  const toolCheck = validateCoderStepResult(result, blueprintStepText);
  if (!toolCheck.ok) {
    return toolCheck;
  }
  if (isBlueprintVerifyStep(blueprintStepText ?? null)) {
    return { ok: true, reason: "coder_verify_step_ok", meaningfulPaths: [] };
  }
  return validateCoderWorkspaceChanges(runGit);
}

export function validateArchitectStepResult(result: StepResult): DeliverableValidationResult {
  const writes = result.toolCalls.filter(
    (call) => call.request.toolName === "write_file" && call.result.ok
  );
  if (writes.length === 0) {
    return {
      ok: false,
      reason:
        "ARCHITECT must call write_file for task-blueprint.md (required) and .mams-rules.md if updating rules.",
      meaningfulPaths: [],
    };
  }
  const paths = writes.map((call) => {
    const args = call.request.args as { path?: string };
    return (args.path ?? "").toLowerCase();
  });
  const wroteBlueprint = paths.some((path) => path.includes("task-blueprint"));
  if (!wroteBlueprint) {
    return {
      ok: false,
      reason: "ARCHITECT must write task-blueprint.md with numbered top-level steps before ending the turn.",
      meaningfulPaths: [],
    };
  }
  const readCount = result.toolCalls.filter(
    (call) => call.request.toolName === "read_file" && call.result.ok
  ).length;
  const listCount = result.toolCalls.filter(
    (call) =>
      (call.request.toolName === "list_repo_structure" || call.request.toolName === "list_changed_files") &&
      call.result.ok
  ).length;
  if (readCount + listCount > 8) {
    return {
      ok: false,
      reason: "ARCHITECT exceeded exploration budget — write blueprint after minimal reads.",
      meaningfulPaths: [],
    };
  }
  return { ok: true, reason: "architect_tool_calls_ok", meaningfulPaths: [] };
}

export function validateTesterStepResult(result: StepResult): DeliverableValidationResult {
  const readCount = countSuccessfulToolCalls(result, "read_file");
  const testCount = countSuccessfulToolCalls(result, "run_local_tests");
  if (readCount === 0) {
    return { ok: false, reason: "TESTER must read at least one file to verify changes.", meaningfulPaths: [] };
  }
  if (testCount === 0) {
    return { ok: false, reason: "TESTER must run at least one run_local_tests command.", meaningfulPaths: [] };
  }
  const narrative = result.narrativeSummary.toLowerCase();
  if (/\bfail(ed|ure)?\b/.test(narrative) && !/\bpass(ed|es)?\b/.test(narrative)) {
    return { ok: false, reason: "TESTER narrative reports failure.", meaningfulPaths: [] };
  }
  return { ok: true, reason: "tester_checks_ok", meaningfulPaths: [] };
}

export async function validatePreDoneDeliverables(runGit: GitProcessRunner): Promise<DeliverableValidationResult> {
  const changes = await collectWorkspaceChanges(runGit);
  if (!hasMeaningfulSourceChanges(changes.allPaths)) {
    return {
      ok: false,
      reason: "Cannot mark DONE: no product source file changes under server/, mobile_app/, or next_app/.",
      meaningfulPaths: filterMeaningfulPaths(changes.allPaths),
    };
  }
  return {
    ok: true,
    reason: "pre_done_ok",
    meaningfulPaths: changes.meaningfulPaths,
  };
}
