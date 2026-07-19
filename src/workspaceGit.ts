/**
 * Git workspace helpers: path parsing, noise filtering, change detection.
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TaskId } from "./types.js";

/** Paths ignored for deliverable validation and git commits. */
export const GIT_NOISE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)\.git\//i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)coverage\//i,
];

/** Directories that count as meaningful product changes. */
export const MEANINGFUL_SOURCE_PREFIXES: readonly string[] = [
  "server/",
  "mobile_app/",
  "next_app/",
  "src/",
  "app/",
  "lib/",
  "packages/",
];

export interface WorkspaceChanges {
  readonly allPaths: readonly string[];
  readonly meaningfulPaths: readonly string[];
  readonly diffText: string;
}

export function normalizeRepoPath(path: string): string {
  let normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  // Git on Windows wraps paths containing spaces/non-ASCII in double quotes.
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

export function isNoiseGitPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return GIT_NOISE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isMeaningfulSourcePath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (isNoiseGitPath(normalized)) {
    return false;
  }
  // Only product code under known package roots — not root-level docs/artifacts.
  return MEANINGFUL_SOURCE_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)
  );
}

/** Parses `git status --porcelain` paths (XY␠PATH or XY␠OLD -> NEW). */
export function parseChangedPathsFromPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 3) {
      continue;
    }
    const match = line.match(/^.. (.+)$/);
    if (!match?.[1]) {
      continue;
    }
    let pathPart = normalizeRepoPath(match[1]);
    if (pathPart.includes(" -> ")) {
      pathPart = normalizeRepoPath(pathPart.split(" -> ").pop()?.trim() ?? pathPart);
    }
    if (pathPart.length > 0) {
      paths.push(pathPart);
    }
  }
  return [...new Set(paths)];
}

export function filterMeaningfulPaths(paths: readonly string[]): string[] {
  return paths.filter(isMeaningfulSourcePath);
}

export function hasMeaningfulSourceChanges(paths: readonly string[]): boolean {
  return filterMeaningfulPaths(paths).length > 0;
}

export interface GitProcessRunner {
  run(args: readonly string[], label: string, timeoutMs?: number): Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export async function collectWorkspaceChanges(
  runGit: GitProcessRunner
): Promise<WorkspaceChanges> {
  const statusResult = await runGit.run(["status", "--porcelain"], "git_status");
  if (statusResult.exitCode !== 0) {
    throw new Error(`git status failed: ${statusResult.stderr || statusResult.stdout}`);
  }
  const allPaths = parseChangedPathsFromPorcelain(statusResult.stdout);
  const diffResult = await runGit.run(["diff", "--no-color"], "git_diff");
  const diffText = diffResult.exitCode === 0 ? diffResult.stdout : "";
  return {
    allPaths,
    meaningfulPaths: filterMeaningfulPaths(allPaths),
    diffText,
  };
}

/** Discard lockfile drift produced by post-clone npm install. */
export async function resetLockfileDrift(sandboxRoot: string, runGit: GitProcessRunner): Promise<void> {
  const gitDir = join(sandboxRoot, ".git");
  if (!existsSync(gitDir)) {
    return;
  }
  const lockPatterns = ["package-lock.json", "server/package-lock.json", "next_app/package-lock.json", "mobile_app/package-lock.json"];
  for (const lockPath of lockPatterns) {
    const fullPath = join(sandboxRoot, lockPath);
    if (!existsSync(fullPath)) {
      continue;
    }
    await runGit.run(["checkout", "--", lockPath], "git_checkout_lockfile");
  }
}

export function slugifyBranchSegment(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "change";
}

export function buildFallbackBranchName(taskId: TaskId): string {
  return `mams/change-${taskId.replace(/-/g, "").slice(0, 8)}`;
}

const GIT_LOCK_FILENAMES: readonly string[] = ["index.lock", "HEAD.lock", "shallow.lock", "packed-refs.lock"];

/** Removes stale git lock files left by interrupted workspace operations. */
export async function releaseWorkspaceDiskLocks(sandboxRoot: string): Promise<void> {
  const gitDir = join(sandboxRoot, ".git");
  if (!existsSync(gitDir)) {
    return;
  }
  await Promise.all(
    GIT_LOCK_FILENAMES.map(async (filename) => {
      try {
        await unlink(join(gitDir, filename));
      } catch {
        // Ignore missing or in-use locks.
      }
    })
  );
}
