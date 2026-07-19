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

export function validateCoderStepResult(result: StepResult): DeliverableValidationResult {
  const writeCount = countSuccessfulToolCalls(result, "write_file");
  if (writeCount === 0) {
    return {
      ok: false,
      reason: "CODER completed without any successful write_file calls.",
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
      reason: "No meaningful source changes detected (only lockfiles or noise).",
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
  runGit: GitProcessRunner
): Promise<DeliverableValidationResult> {
  const toolCheck = validateCoderStepResult(result);
  if (!toolCheck.ok) {
    return toolCheck;
  }
  return validateCoderWorkspaceChanges(runGit);
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
      reason: "Cannot mark DONE: no meaningful source file changes in workspace.",
      meaningfulPaths: filterMeaningfulPaths(changes.allPaths),
    };
  }
  return {
    ok: true,
    reason: "pre_done_ok",
    meaningfulPaths: changes.meaningfulPaths,
  };
}
