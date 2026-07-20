/**
 * Git workspace helpers: path parsing, noise filtering, change detection.
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TaskId } from "./types.js";

/** CODER scratch / probe files — excluded from reads, git noise, and repo listings. */
export const WORKSPACE_SCRATCH_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)script[^/]*\.js$/i,
  /(^|\/)tmp_[^/]*$/i,
];

/** Heavy build/cache directories excluded from tree, search, and agent context. */
export const WORKSPACE_HEAVY_DIR_PATTERNS: readonly RegExp[] = [
  /(^|\/)node_modules\//i,
  /(^|\/)\.git\//i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)coverage\//i,
  /(^|\/)\.next\//i,
  /(^|\/)\.turbo\//i,
  /(^|\/)out\//i,
  /(^|\/)\.expo\//i,
  /(^|\/)android\/\.gradle\//i,
  /(^|\/)ios\/Pods\//i,
  /(^|\/)\.cache\//i,
];

/** Binary/media assets — never read, search, or list in workspace context. */
export const WORKSPACE_BINARY_ASSET_PATTERNS: readonly RegExp[] = [
  /\.(png|jpe?g|gif|webp|svg|ico|pck|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin)$/i,
];

/** Paths ignored for deliverable validation and git commits. */
export const GIT_NOISE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  ...WORKSPACE_HEAVY_DIR_PATTERNS,
  ...WORKSPACE_BINARY_ASSET_PATTERNS,
  ...WORKSPACE_SCRATCH_FILE_PATTERNS,
];

export const WORKSPACE_TREE_MAX_DEPTH = 3;
export const WORKSPACE_TREE_MAX_ENTRIES_PER_DEPTH = 35;

export function isHeavyWorkspacePath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return WORKSPACE_HEAVY_DIR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isBinaryAssetPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return WORKSPACE_BINARY_ASSET_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** True when a path must never appear in trees, search, or read tools. */
export function isExcludedFromWorkspaceContext(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (normalized.length === 0) {
    return true;
  }
  return (
    isNoiseGitPath(normalized) ||
    isHeavyWorkspacePath(normalized) ||
    isBinaryAssetPath(normalized) ||
    isWorkspaceScratchPath(normalized)
  );
}

export interface ShallowWorkspaceTree {
  readonly tree: string;
  readonly fileCount: number;
  readonly pathsConsidered: number;
}

/** Builds a shallow directory tree (depth 1–3) — no leaf-file explosion. */
export function buildShallowWorkspaceTree(
  paths: readonly string[],
  options: { readonly maxDepth?: number; readonly maxEntriesPerDepth?: number } = {}
): ShallowWorkspaceTree {
  const maxDepth = options.maxDepth ?? WORKSPACE_TREE_MAX_DEPTH;
  const maxEntriesPerDepth = options.maxEntriesPerDepth ?? WORKSPACE_TREE_MAX_ENTRIES_PER_DEPTH;
  const filtered = paths.filter((path) => !isExcludedFromWorkspaceContext(path));
  const depthBuckets = new Map<number, Set<string>>();

  for (const path of filtered) {
    const parts = path.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) {
      continue;
    }
    for (let depth = 1; depth <= Math.min(maxDepth, parts.length); depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      const bucket = depthBuckets.get(depth) ?? new Set<string>();
      bucket.add(prefix);
      depthBuckets.set(depth, bucket);
    }
  }

  const lines: string[] = [
    `## Workspace layout (shallow, max depth ${maxDepth})`,
    "Heavy dirs (.next, dist, node_modules, binaries) omitted.",
  ];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const bucket = depthBuckets.get(depth);
    if (!bucket || bucket.size === 0) {
      continue;
    }
    const sorted = [...bucket].sort();
    const shown = sorted.slice(0, maxEntriesPerDepth);
    lines.push(`### Depth ${depth}`, ...shown);
    if (sorted.length > shown.length) {
      lines.push(`… +${sorted.length - shown.length} more at depth ${depth}`);
    }
  }

  const deeperPaths = filtered.filter((path) => path.split("/").filter(Boolean).length > maxDepth).length;
  if (deeperPaths > 0) {
    lines.push(`(${deeperPaths} deeper file paths omitted — use search_files / read_file_slice)`);
  }

  return {
    tree: lines.join("\n"),
    fileCount: filtered.length,
    pathsConsidered: paths.length,
  };
}

export async function listFilteredRepoPaths(
  runGit: GitProcessRunner,
  pathPrefix = "."
): Promise<string[]> {
  const prefix = normalizeRepoPath(pathPrefix);
  const args =
    prefix === "." || prefix.length === 0
      ? (["ls-files", "--cached", "--others", "--exclude-standard"] as const)
      : (["ls-files", "--cached", "--others", "--exclude-standard", "--", prefix] as const);
  const result = await runGit.run(args, "git_ls_files_filtered");
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => normalizeRepoPath(line.trim()))
    .filter((line) => line.length > 0 && !isExcludedFromWorkspaceContext(line));
}

export function isWorkspaceScratchPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return WORKSPACE_SCRATCH_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

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

/** Parses untracked (`??`) paths from `git status --porcelain`. */
export function parseUntrackedPathsFromPorcelain(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("?? ")) {
      continue;
    }
    const pathPart = normalizeRepoPath(line.slice(3));
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
