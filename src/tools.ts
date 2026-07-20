/**
 * Tool implementations for the MAMS execution plane.
 * Every file/process operation is confined to AGENT_WORKSPACES_BASE_DIR.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskId } from "./types.js";
import { buildGitMetadata } from "./gitMetadata.js";
import {
  buildFallbackBranchName,
  buildShallowWorkspaceTree,
  collectWorkspaceChanges,
  hasMeaningfulSourceChanges,
  isExcludedFromWorkspaceContext,
  isWorkspaceScratchPath,
  listFilteredRepoPaths,
  normalizeRepoPath,
  parseUntrackedPathsFromPorcelain,
  resetLockfileDrift,
  type GitProcessRunner,
} from "./workspaceGit.js";
import { tool } from "ai";
import { z } from "zod";
import { loadMamsEnv, MamsEnvSchema, type MamsEnv } from "./env.js";
import {
  buildClaudeCodeCliArgs,
  buildClaudeCodeContainerEnv,
  buildClaudeCodeSpawnEnv,
  checkClaudeCodeAvailability,
} from "./claudeCode.js";
import { validateArchitectStepResult } from "./deliverableValidation.js";
import { registerChildProcess, registerDockerContainerId } from "./processRegistry.js";
import { releaseDevServerPorts } from "./portCleanup.js";
import type { StepResult } from "./types.js";

export { MamsEnvSchema, loadMamsEnv, type MamsEnv };

export const PROJECT_RULES_FILENAME = ".mams-rules.md";
export const PROJECT_RULES_SECTION_HEADER = "=== TARGET PROJECT ARCHITECTURAL RULES ===";
export const TASK_BLUEPRINT_FILENAME = "task-blueprint.md";

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /<!--\s*example/i,
  /your-org\/your-repo/i,
  /user:password@localhost/i,
  /fill in/i,
  /replace with/i,
  /todo:/i,
  /\(none specified\)/i,
  /<!--\s*\.\.\./i,
  /example\.com/i,
];

export interface WorkspaceContextAssessment {
  readonly requiresArchitectureAlignment: boolean;
  readonly reason: string;
}

function isPlaceholderRulesContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 120) {
    return true;
  }
  const nonHeadingLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(">"));
  if (nonHeadingLines.length < 3) {
    return true;
  }
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Context Assessment Phase — inspect `.mams-rules.md` for structural completeness. */
export async function assessWorkspaceContext(sandboxRoot: string): Promise<WorkspaceContextAssessment> {
  assertSandboxRootIsContained(sandboxRoot);
  let rulesPath: string;
  try {
    rulesPath = resolveSandboxPath(sandboxRoot, PROJECT_RULES_FILENAME);
  } catch {
    return { requiresArchitectureAlignment: true, reason: "rules_path_unavailable" };
  }

  try {
    const content = await readFile(rulesPath, "utf8");
    if (content.trim().length === 0) {
      return { requiresArchitectureAlignment: true, reason: "rules_empty" };
    }
    if (isPlaceholderRulesContent(content)) {
      return { requiresArchitectureAlignment: true, reason: "rules_placeholder_only" };
    }
    return { requiresArchitectureAlignment: false, reason: "rules_substantive" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { requiresArchitectureAlignment: true, reason: "rules_missing" };
    }
    return { requiresArchitectureAlignment: true, reason: "rules_unreadable" };
  }
}

/** Parses top-level numbered steps only (1. / 2.) — sub-bullets are not separate steps. */
export async function readBlueprintSteps(sandboxRoot: string): Promise<readonly string[]> {
  try {
    const blueprintPath = resolveSandboxPath(sandboxRoot, TASK_BLUEPRINT_FILENAME);
    const content = await readFile(blueprintPath, "utf8");
    const steps: string[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*\d+[\.)]\s+(.+)$/);
      if (match?.[1]) {
        steps.push(match[1].trim());
      }
    }
    return steps;
  } catch {
    return [];
  }
}

export async function readBlueprintStep(sandboxRoot: string, stepIndex: number): Promise<string | null> {
  const steps = await readBlueprintSteps(sandboxRoot);
  return steps[stepIndex] ?? null;
}

export interface ValidateArchitectureArtifactsOptions {
  /** Requires ARCHITECT to have successfully written task-blueprint.md in this turn (ignores stale disk files). */
  readonly stepResult?: StepResult;
}

export async function validateArchitectureArtifacts(
  sandboxRoot: string,
  options: ValidateArchitectureArtifactsOptions = {}
): Promise<boolean> {
  if (options.stepResult) {
    const activeWrite = validateArchitectStepResult(options.stepResult);
    if (!activeWrite.ok) {
      return false;
    }
  }

  try {
    const rulesPath = resolveSandboxPath(sandboxRoot, PROJECT_RULES_FILENAME);
    const blueprintPath = resolveSandboxPath(sandboxRoot, TASK_BLUEPRINT_FILENAME);
    const [rules, blueprint] = await Promise.all([readFile(rulesPath, "utf8"), readFile(blueprintPath, "utf8")]);
    const steps = await readBlueprintSteps(sandboxRoot);
    return (
      rules.trim().length > 0 &&
      blueprint.trim().length > 0 &&
      !isPlaceholderRulesContent(rules) &&
      steps.length > 0
    );
  } catch {
    return false;
  }
}

// From dist/tools.js -> ../workspaces = mams-core-service/workspaces/
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const AGENT_WORKSPACES_BASE_DIR = resolve(__dirname, "..", "workspaces");
mkdirSync(AGENT_WORKSPACES_BASE_DIR, { recursive: true });

export class SandboxViolationError extends Error {
  public override readonly name = "SandboxViolationError";

  constructor(public readonly root: string, public readonly requestedPath: string) {
    super(`Path "${requestedPath}" resolves outside sandbox root "${root}" — refusing to touch it.`);
  }
}

export class SandboxRootViolationError extends Error {
  public override readonly name = "SandboxRootViolationError";

  constructor(public readonly attemptedRoot: string) {
    super(
      `Refusing sandbox root "${attemptedRoot}": it does not resolve inside "${AGENT_WORKSPACES_BASE_DIR}".`
    );
  }
}

export class DependencyInstallError extends Error {
  public override readonly name = "DependencyInstallError";

  constructor(
    public readonly installPath: string,
    message: string,
    public readonly exitCode: number | null = null
  ) {
    super(message);
  }
}

/** Strips PATs and token-bearing URLs from process output before logging or throwing. */
export function sanitizeSensitiveOutput(text: string): string {
  let sanitized = text;
  try {
    const env = loadMamsEnv();
    if (env.GITHUB_AUTH_TOKEN.length >= 4) {
      sanitized = sanitized.replaceAll(env.GITHUB_AUTH_TOKEN, "[REDACTED]");
    }
  } catch {
    const token = process.env.GITHUB_AUTH_TOKEN;
    if (token && token.length >= 4) {
      sanitized = sanitized.replaceAll(token, "[REDACTED]");
    }
  }
  sanitized = sanitized.replace(/https:\/\/[^\s/@]+@/gi, "https://[REDACTED]@");
  sanitized = sanitized.replace(
    /Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi,
    "Authorization: Basic [REDACTED]"
  );
  return sanitized;
}

function buildCleanGitRepoUrl(repoUrl: string): string {
  const parsed = new URL(repoUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`GITHUB_REPO_URL must use HTTPS; got "${parsed.protocol}".`);
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** In-memory GitHub HTTPS auth — never persisted to `.git/config`. */
function gitHttpAuthConfigArgs(token: string): readonly string[] {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/** Resolves symlinks via realpathSync; creates missing leaf directories first. */
function resolveRealPath(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }
  const parent = dirname(path);
  if (parent !== path) {
    mkdirSync(parent, { recursive: true });
    if (existsSync(parent)) {
      return resolve(resolveRealPath(parent), basename(path));
    }
  }
  return resolve(path);
}

function getRealWorkspacesBaseDir(): string {
  return resolveRealPath(AGENT_WORKSPACES_BASE_DIR);
}

export function assertSandboxRootIsContained(root: string): string {
  const realBase = getRealWorkspacesBaseDir();
  mkdirSync(root, { recursive: true });
  const realRoot = resolveRealPath(resolve(root));
  const rel = relative(realBase, realRoot);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxRootViolationError(realRoot);
  }
  return realRoot;
}

export function resolveSandboxPath(root: string, requestedPath: string): string {
  const realRoot = assertSandboxRootIsContained(root);
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(realRoot, requestedPath);
  const realCandidate = resolveRealPath(candidate);
  const rel = relative(realRoot, realCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxViolationError(realRoot, requestedPath);
  }
  return realCandidate;
}

const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export interface WriteFileOutput {
  readonly path: string;
  readonly bytesWritten: number;
  readonly verifiedReadBack: boolean;
}

export function createWriteFileTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description: "Writes a file within the task sandbox. Overwrites if exists.",
    inputSchema: WriteFileInputSchema,
    execute: async ({ path, content }): Promise<WriteFileOutput> => {
      if (isWorkspaceScratchPath(path)) {
        throw new Error(
          `Refusing to write scratch/probe file "${path}" (script*.js, tmp_*). Edit product source files under server/, mobile_app/, etc.`
        );
      }
      const absolutePath = resolveSandboxPath(sandboxRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      const readBack = await readFile(absolutePath, "utf8").catch(() => null);
      return {
        path,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        verifiedReadBack: readBack === content,
      };
    },
  });
}

const ReadFileInputSchema = z.object({
  path: z.string().min(1),
});

/** Max tool response body returned to the LLM (search_files, read_file_slice). */
export const MAX_TOOL_RESPONSE_BYTES = 4 * 1024;
const TOOL_RESPONSE_TRUNCATION_WARNING =
  "\n[MAMS SYSTEM WARNING: Tool output truncated to 4KB — refine query, pathPrefix, startLine, or lineCount.]";

export function capToolResponseText(
  text: string,
  maxBytes: number = MAX_TOOL_RESPONSE_BYTES
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }
  const tail = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength(TOOL_RESPONSE_TRUNCATION_WARNING, "utf8")));
  return { text: `${TOOL_RESPONSE_TRUNCATION_WARNING}${tail.toString("utf8")}`, truncated: true };
}

/** Max lines returned by read_file_slice (token budget). */
export const MAX_READ_FILE_SLICE_LINES = 80;
export const MAX_READ_FILE_SLICE_CHARS = MAX_TOOL_RESPONSE_BYTES;
/** Max matches returned by search_files per call. */
export const MAX_SEARCH_FILE_MATCHES = 25;
/** Keep full read_file payloads bounded — prefer read_file_slice / search_files first. */
export const MAX_READ_FILE_CHARS = 24_000;
export const MAX_ARCHITECT_READ_FILE_CHARS = 12_000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SEARCHABLE_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|prisma|css|scss|yaml|yml)$/i;

const readFileTurnCache = new Map<string, ReadFileOutput>();

export function clearReadFileTurnCache(sandboxRoot?: string): void {
  if (sandboxRoot === undefined) {
    readFileTurnCache.clear();
    return;
  }
  const prefix = `${assertSandboxRootIsContained(sandboxRoot)}:`;
  for (const key of readFileTurnCache.keys()) {
    if (key.startsWith(prefix)) {
      readFileTurnCache.delete(key);
    }
  }
}

function readFileCacheKey(sandboxRoot: string, relativePath: string): string {
  return `${assertSandboxRootIsContained(sandboxRoot)}:${relativePath.replace(/\\/g, "/")}`;
}

/** Raw implementation sources are never readable by ARCHITECT (context bloat). */
const ARCHITECT_BLOCKED_READ_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

/** ARCHITECT may only read these paths (exploration budget — prevents token blow-ups). */
export const ARCHITECT_READ_ALLOWLIST: readonly RegExp[] = [
  /(^|\/)package\.json$/i,
  /(^|\/)server\/package\.json$/i,
  /(^|\/)mobile_app\/package\.json$/i,
  /(^|\/)next_app\/package\.json$/i,
  /(^|\/)server\/prisma\/schema\.prisma$/i,
  /(^|\/)app\.json$/i,
  /(^|\/)tsconfig\.json$/i,
  /^\.mams-rules\.md$/i,
  /^task-blueprint\.md$/i,
];

export function isArchitectReadPathAllowed(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (ARCHITECT_BLOCKED_READ_EXTENSIONS.test(normalized)) {
    return false;
  }
  return ARCHITECT_READ_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

export interface ReadFileOutput {
  readonly path: string;
  readonly content: string;
  readonly truncated?: boolean;
  readonly totalChars?: number;
}

function isBlockedReadPath(relativePath: string): string | null {
  if (isExcludedFromWorkspaceContext(relativePath)) {
    if (isWorkspaceScratchPath(relativePath)) {
      return "Refusing to read scratch/probe files (script*.js, tmp_*). Use search_files on product source paths instead.";
    }
    return "Refusing to read heavy build/cache paths, binaries (.png/.jpg/.pck), or dependency folders. Use search_files + read_file_slice on source paths.";
  }
  return null;
}

function truncateReadFileContent(content: string): Pick<ReadFileOutput, "content" | "truncated" | "totalChars"> {
  const totalChars = content.length;
  if (totalChars <= MAX_READ_FILE_CHARS) {
    return { content, totalChars };
  }
  return {
    content:
      content.slice(0, MAX_READ_FILE_CHARS) +
      `\n\n[TRUNCATED: showing first ${MAX_READ_FILE_CHARS} of ${totalChars} characters. Use a narrower path or run_local_tests instead of reading huge files.]`,
    truncated: true,
    totalChars,
  };
}

export function createReadFileTool(sandboxRoot: string, options: { readonly architectMode?: boolean } = {}) {
  assertSandboxRootIsContained(sandboxRoot);
  const maxChars = options.architectMode ? MAX_ARCHITECT_READ_FILE_CHARS : MAX_READ_FILE_CHARS;
  return tool({
    description: options.architectMode
      ? `Reads allowlisted UTF-8 files only (max ${MAX_ARCHITECT_READ_FILE_CHARS} chars): package.json, schema.prisma, app.json, tsconfig, .mams-rules.md.`
      : `Reads a UTF-8 text file within the task sandbox (max ${MAX_READ_FILE_CHARS} chars; node_modules/ and .git/ blocked).`,
    inputSchema: ReadFileInputSchema,
    execute: async ({ path }): Promise<ReadFileOutput> => {
      if (options.architectMode && !isArchitectReadPathAllowed(path)) {
        const allowed = ARCHITECT_READ_ALLOWLIST.map((p) => p.source).join(", ");
        throw new Error(
          `Refusing ARCHITECT read of "${path}". Allowed: config files only (${allowed}). ` +
            `Source files (.ts/.tsx/.js/.py) are blocked — use list_repo_structure for layout.`
        );
      }
      const blockedReason = isBlockedReadPath(path);
      if (blockedReason) {
        return { path, content: blockedReason, truncated: false, totalChars: blockedReason.length };
      }
      const cacheKey = readFileCacheKey(sandboxRoot, path);
      const cached = readFileTurnCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const absolutePath = resolveSandboxPath(sandboxRoot, path);
      const raw = await readFile(absolutePath, "utf8");
      const totalChars = raw.length;
      const content =
        totalChars <= maxChars
          ? raw
          : raw.slice(0, maxChars) +
            `\n\n[TRUNCATED: showing first ${maxChars} of ${totalChars} characters.]`;
      const output: ReadFileOutput = {
        path,
        content,
        ...(totalChars > maxChars ? { truncated: true, totalChars } : { totalChars }),
      };
      readFileTurnCache.set(cacheKey, output);
      return output;
    },
  });
}

/** Project metadata paths verification agents may read without a workspace diff. */
const VERIFIER_METADATA_READ_ALLOWLIST: readonly RegExp[] = ARCHITECT_READ_ALLOWLIST;

function normalizeRelativeRepoPath(relativePath: string): string {
  return normalizeRepoPath(relativePath);
}

function isVerifierMetadataReadPath(relativePath: string): boolean {
  const normalized = normalizeRelativeRepoPath(relativePath);
  return VERIFIER_METADATA_READ_ALLOWLIST.some((pattern) => pattern.test(normalized));
}

function isPathInChangedSet(relativePath: string, changedPaths: readonly string[]): boolean {
  const normalized = normalizeRelativeRepoPath(relativePath);
  return changedPaths.some((changed) => normalizeRelativeRepoPath(changed) === normalized);
}

async function readSandboxTextFile(
  sandboxRoot: string,
  path: string,
  maxChars: number
): Promise<ReadFileOutput> {
  const absolutePath = resolveSandboxPath(sandboxRoot, path);
  const raw = await readFile(absolutePath, "utf8");
  const totalChars = raw.length;
  const content =
    totalChars <= maxChars
      ? raw
      : raw.slice(0, maxChars) + `\n\n[TRUNCATED: showing first ${maxChars} of ${totalChars} characters.]`;
  return {
    path,
    content,
    ...(totalChars > maxChars ? { truncated: true, totalChars } : { totalChars }),
  };
}

/** Restricted read_file for TESTER/QA/SPEC_REVIEWER — metadata or changed workspace files only. */
export function createVerifierReadFileTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description:
      "Reads UTF-8 files for verification: project metadata (package.json, schema.prisma, tsconfig) or files changed in this workspace.",
    inputSchema: ReadFileInputSchema,
    execute: async ({ path }): Promise<ReadFileOutput> => {
      const blockedReason = isBlockedReadPath(path);
      if (blockedReason) {
        return { path, content: blockedReason, truncated: false, totalChars: blockedReason.length };
      }
      const realRoot = assertSandboxRootIsContained(sandboxRoot);
      const changes = await collectWorkspaceChanges(createSandboxGitRunner(realRoot));
      const changedPaths = [...new Set([...changes.allPaths, ...changes.meaningfulPaths])];
      if (!isVerifierMetadataReadPath(path) && !isPathInChangedSet(path, changedPaths)) {
        throw new Error(
          `Refusing verifier read of "${path}". Allowed: metadata files (package.json, schema.prisma, tsconfig, .mams-rules.md) or paths returned by list_changed_files.`
        );
      }
      return readSandboxTextFile(realRoot, path, MAX_READ_FILE_CHARS);
    },
  });
}

const ReadFileSliceInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(MAX_READ_FILE_SLICE_LINES).default(80),
});

export interface ReadFileSliceOutput {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
  readonly truncated?: boolean;
}

async function readSandboxTextSlice(
  sandboxRoot: string,
  path: string,
  startLine: number,
  lineCount: number
): Promise<ReadFileSliceOutput> {
  const absolutePath = resolveSandboxPath(sandboxRoot, path);
  const raw = await readFile(absolutePath, "utf8");
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const safeStart = Math.min(Math.max(startLine, 1), totalLines === 0 ? 1 : totalLines);
  const safeCount = Math.min(lineCount, MAX_READ_FILE_SLICE_LINES);
  const endLine = Math.min(safeStart + safeCount - 1, totalLines);
  const selected = lines.slice(safeStart - 1, endLine);
  let content = selected
    .map((line, index) => `${String(safeStart + index).padStart(6, " ")}| ${line}`)
    .join("\n");
  let truncated = false;
  const capped = capToolResponseText(content, MAX_TOOL_RESPONSE_BYTES);
  content = capped.text;
  truncated = capped.truncated;
  return { path, startLine: safeStart, endLine, totalLines, content, ...(truncated ? { truncated } : {}) };
}

async function assertVerifierMayAccessPath(
  sandboxRoot: string,
  path: string
): Promise<void> {
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const changes = await collectWorkspaceChanges(createSandboxGitRunner(realRoot));
  const changedPaths = [...new Set([...changes.allPaths, ...changes.meaningfulPaths])];
  if (!isVerifierMetadataReadPath(path) && !isPathInChangedSet(path, changedPaths)) {
    throw new Error(
      `Refusing verifier access to "${path}". Allowed: metadata files or paths from list_changed_files.`
    );
  }
}

export function createReadFileSliceTool(
  sandboxRoot: string,
  options: { readonly architectMode?: boolean; readonly verifierMode?: boolean } = {}
) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description: `Reads a line range from a UTF-8 file (max ${MAX_READ_FILE_SLICE_LINES} lines). Prefer this over read_file for large sources.`,
    inputSchema: ReadFileSliceInputSchema,
    execute: async ({ path, startLine, lineCount }): Promise<ReadFileSliceOutput> => {
      if (options.architectMode && !isArchitectReadPathAllowed(path)) {
        throw new Error(`Refusing ARCHITECT slice read of "${path}".`);
      }
      const blockedReason = isBlockedReadPath(path);
      if (blockedReason) {
        return {
          path,
          startLine: 1,
          endLine: 1,
          totalLines: 0,
          content: blockedReason,
        };
      }
      if (options.verifierMode) {
        await assertVerifierMayAccessPath(sandboxRoot, path);
      }
      return readSandboxTextSlice(assertSandboxRootIsContained(sandboxRoot), path, startLine, lineCount);
    },
  });
}

const SearchFilesInputSchema = z.object({
  query: z.string().min(1),
  pathPrefix: z.string().default("."),
  maxMatches: z.number().int().min(1).max(MAX_SEARCH_FILE_MATCHES).default(20),
  caseSensitive: z.boolean().default(false),
});

export interface SearchFilesMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchFilesOutput {
  readonly query: string;
  readonly pathPrefix: string;
  readonly matches: readonly SearchFilesMatch[];
  readonly truncated: boolean;
  readonly filesScanned: number;
}

async function listSearchableRepoFiles(sandboxRoot: string, pathPrefix: string): Promise<string[]> {
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const files = await listFilteredRepoPaths(createSandboxGitRunner(realRoot), pathPrefix);
  return files.filter((line) => SEARCHABLE_EXTENSIONS.test(line));
}

async function searchWorkspaceFiles(
  sandboxRoot: string,
  query: string,
  options: {
    readonly pathPrefix: string;
    readonly maxMatches: number;
    readonly caseSensitive: boolean;
    readonly allowedPaths?: ReadonlySet<string>;
  }
): Promise<SearchFilesOutput> {
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const files = await listSearchableRepoFiles(realRoot, options.pathPrefix);
  const scopedFiles =
    options.allowedPaths === undefined
      ? files
      : files.filter((file) => options.allowedPaths!.has(normalizeRelativeRepoPath(file)));
  const matches: SearchFilesMatch[] = [];
  let filesScanned = 0;

  for (const relPath of scopedFiles) {
    if (matches.length >= options.maxMatches) {
      break;
    }
    filesScanned += 1;
    let absolutePath: string;
    try {
      absolutePath = resolveSandboxPath(realRoot, relPath);
    } catch {
      continue;
    }
    let raw: string;
    try {
      const stat = await readFile(absolutePath, "utf8");
      if (Buffer.byteLength(stat, "utf8") > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      raw = stat;
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (matches.length >= options.maxMatches) {
        break;
      }
      const line = lines[lineIndex] ?? "";
      const haystack = options.caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
      matches.push({
        path: relPath,
        line: lineIndex + 1,
        text: line.trim().slice(0, 120),
      });
    }
  }

  let truncated = matches.length >= options.maxMatches;
  let responseBody = JSON.stringify({ query, pathPrefix: options.pathPrefix, matches, filesScanned });
  if (Buffer.byteLength(responseBody, "utf8") > MAX_TOOL_RESPONSE_BYTES) {
    const cappedMatches: SearchFilesMatch[] = [];
    for (const match of matches) {
      cappedMatches.push(match);
      responseBody = JSON.stringify({
        query,
        pathPrefix: options.pathPrefix,
        matches: cappedMatches,
        filesScanned,
      });
      if (Buffer.byteLength(responseBody, "utf8") > MAX_TOOL_RESPONSE_BYTES - 256) {
        cappedMatches.pop();
        truncated = true;
        break;
      }
    }
    return {
      query,
      pathPrefix: options.pathPrefix,
      matches: cappedMatches,
      truncated: true,
      filesScanned,
    };
  }

  return {
    query,
    pathPrefix: options.pathPrefix,
    matches,
    truncated,
    filesScanned,
  };
}

export function createSearchFilesTool(
  sandboxRoot: string,
  options: { readonly verifierMode?: boolean } = {}
) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description:
      "Searches tracked workspace files for a literal string and returns path:line snippets (token-efficient). Use before read_file_slice.",
    inputSchema: SearchFilesInputSchema,
    execute: async ({ query, pathPrefix, maxMatches, caseSensitive }): Promise<SearchFilesOutput> => {
      const realRoot = assertSandboxRootIsContained(sandboxRoot);
      let allowedPaths: ReadonlySet<string> | undefined;
      if (options.verifierMode) {
        const changes = await collectWorkspaceChanges(createSandboxGitRunner(realRoot));
        allowedPaths = new Set(
          [...changes.allPaths, ...changes.meaningfulPaths].map((path) => normalizeRelativeRepoPath(path))
        );
      }
      return searchWorkspaceFiles(realRoot, query, {
        pathPrefix,
        maxMatches: Math.min(maxMatches, MAX_SEARCH_FILE_MATCHES),
        caseSensitive,
        ...(allowedPaths ? { allowedPaths } : {}),
      });
    },
  });
}

/** Deletes untracked scratch/probe files (script*.js, tmp_*) from the sandbox disk. */
export async function cleanupWorkspaceScratchFiles(
  sandboxRoot: string
): Promise<{ readonly deletedPaths: readonly string[] }> {
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const gitDir = join(realRoot, ".git");
  if (!existsSync(gitDir)) {
    return { deletedPaths: [] };
  }

  const runner = createSandboxGitRunner(realRoot);
  const status = await runner.run(["status", "--porcelain"], "git_status_scratch_cleanup");
  if (status.exitCode !== 0) {
    return { deletedPaths: [] };
  }

  const deletedPaths: string[] = [];
  for (const relPath of parseUntrackedPathsFromPorcelain(status.stdout)) {
    if (!isWorkspaceScratchPath(relPath)) {
      continue;
    }
    try {
      await unlink(resolveSandboxPath(realRoot, relPath));
      deletedPaths.push(relPath);
    } catch {
      // Best-effort cleanup — ignore busy or already-deleted files.
    }
  }

  if (deletedPaths.length > 0) {
    console.log(`[workspace] Removed ${deletedPaths.length} scratch file(s): ${deletedPaths.join(", ")}`);
  }

  return { deletedPaths };
}

export function createListRepoStructureTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description:
      "Lists a shallow workspace directory tree (depth 1–3; excludes .next, dist, node_modules, binaries).",
    inputSchema: z.object({}).default({}),
    execute: async (): Promise<{ readonly tree: string; readonly fileCount: number }> => {
      const realRoot = assertSandboxRootIsContained(sandboxRoot);
      const paths = await listFilteredRepoPaths(createSandboxGitRunner(realRoot));
      const layout = buildShallowWorkspaceTree(paths);
      const capped = capToolResponseText(layout.tree, MAX_TOOL_RESPONSE_BYTES);
      return {
        tree: capped.text,
        fileCount: layout.fileCount,
      };
    },
  });
}

const DockerSandboxOptionsSchema = z.object({
  image: z.string().min(1),
  memoryLimit: z.string().min(1).default("512m"),
  cpus: z.string().min(1).default("1.0"),
  pidsLimit: z.number().int().positive().default(256),
  user: z
    .string()
    .min(1)
    .default("1000:1000")
    .refine((value) => !/^(root|0)(:(root|0))?$/i.test(value.trim()), {
      message: 'Refusing root Docker user ("root", "0", or "0:0").',
    }),
});

type DockerSandboxOptions = z.infer<typeof DockerSandboxOptionsSchema>;

const RunLocalTestsInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  docker: DockerSandboxOptionsSchema.nullable().default(null),
});

export interface RunLocalTestsOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024;
const OUTPUT_TRUNCATION_WARNING =
  "\n[MAMS SYSTEM WARNING: Output truncated to protect context window limit]...";

function truncateCapturedProcessOutput(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_CAPTURED_OUTPUT_BYTES) {
    return text;
  }
  const buf = Buffer.from(text, "utf8");
  const tail = buf.subarray(Math.max(0, buf.length - MAX_CAPTURED_OUTPUT_BYTES)).toString("utf8");
  return `${OUTPUT_TRUNCATION_WARNING}${tail}`;
}

function buildDockerInvocation(
  absoluteSandboxRoot: string,
  cwd: string,
  docker: DockerSandboxOptions,
  command: string,
  args: readonly string[],
  containerName: string,
  containerEnv: Record<string, string> = {}
): { readonly command: string; readonly args: readonly string[] } {
  const containerWorkdir = (cwd === "." ? "/workspace" : `/workspace/${cwd}`).replace(/\/+$/, "") || "/workspace";
  registerDockerContainerId(containerName);
  const envArgs = Object.entries(containerEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "none",
      "--memory",
      docker.memoryLimit,
      "--cpus",
      docker.cpus,
      "--pids-limit",
      String(docker.pidsLimit),
      "--user",
      docker.user,
      ...envArgs,
      "-v",
      `${absoluteSandboxRoot}:/workspace:rw`,
      "-w",
      containerWorkdir,
      docker.image,
      command,
      ...args,
    ],
  };
}

function resolveSpawnTarget(command: string): { readonly command: string; readonly shell: boolean } {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return { command, shell: true };
  }
  return { command, shell: false };
}

/** Ensures Node's install directory is on PATH for child processes (Windows npm.cmd). */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== "win32") {
    return env;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const nodeBinDir = dirname(process.execPath);
  const currentPath = env[pathKey] ?? "";
  const pathEntries = currentPath.split(";").map((entry) => entry.trim().toLowerCase());
  if (!pathEntries.includes(nodeBinDir.toLowerCase())) {
    env[pathKey] = currentPath ? `${currentPath};${nodeBinDir}` : nodeBinDir;
  }
  return env;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  label: string,
  isDocker = false,
  spawnEnv: NodeJS.ProcessEnv = buildSpawnEnv()
): Promise<RunLocalTestsOutput> {
  return new Promise((resolvePromise) => {
    void (async () => {
      if (label === "run_local_tests" && !isDocker) {
        await releaseDevServerPorts(command, args);
      }

      const startedAt = Date.now();
      const spawnTarget = resolveSpawnTarget(command);
      const child = spawn(spawnTarget.command, args, {
        cwd,
        shell: spawnTarget.shell,
        env: spawnEnv,
      });
      registerChildProcess(child, label, isDocker);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let stdoutRawBytes = 0;
      let stderrRawBytes = 0;

      const appendChunk = (buf: string, chunk: Buffer): { readonly text: string; readonly rawBytes: number } => {
        const nextRawBytes = Buffer.byteLength(buf, "utf8") + chunk.length;
        return { text: buf + chunk.toString("utf8"), rawBytes: nextRawBytes };
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const next = appendChunk(stdout, chunk);
        stdout = next.text;
        stdoutRawBytes = next.rawBytes;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const next = appendChunk(stderr, chunk);
        stderr = next.text;
        stderrRawBytes = next.rawBytes;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const settle = (output: RunLocalTestsOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(output);
      };

      child.on("error", (err) => {
        settle({
          exitCode: null,
          stdout: sanitizeSensitiveOutput(
            stdoutRawBytes > MAX_CAPTURED_OUTPUT_BYTES ? truncateCapturedProcessOutput(stdout) : stdout
          ),
          stderr: sanitizeSensitiveOutput(
            (stderrRawBytes > MAX_CAPTURED_OUTPUT_BYTES ? truncateCapturedProcessOutput(stderr) : stderr) +
              `\n[run_process] Failed to spawn "${command}": ${String(err)}`
          ),
          timedOut: false,
          durationMs: Date.now() - startedAt,
        });
      });

      child.on("close", (code) => {
        settle({
          exitCode: code,
          stdout: sanitizeSensitiveOutput(
            stdoutRawBytes > MAX_CAPTURED_OUTPUT_BYTES ? truncateCapturedProcessOutput(stdout) : stdout
          ),
          stderr: sanitizeSensitiveOutput(
            stderrRawBytes > MAX_CAPTURED_OUTPUT_BYTES ? truncateCapturedProcessOutput(stderr) : stderr
          ),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    })();
  });
}

export function createRunLocalTestsTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description: "Runs a test/build/lint command in the task sandbox (bare process or Docker).",
    inputSchema: RunLocalTestsInputSchema,
    execute: async ({ command, args, cwd, timeoutMs, docker }): Promise<RunLocalTestsOutput> => {
      const absoluteSandboxRoot = assertSandboxRootIsContained(sandboxRoot);
      const resolvedCwd = resolveSandboxPath(sandboxRoot, cwd);
      const containerName = `mams-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const invocation = docker
        ? buildDockerInvocation(absoluteSandboxRoot, cwd, docker, command, args, containerName)
        : { command, args };
      const spawnCwd = docker ? absoluteSandboxRoot : resolvedCwd;

      return runProcess(invocation.command, invocation.args, spawnCwd, timeoutMs, "run_local_tests", Boolean(docker));
    },
  });
}

const ClaudeCodeEscalationInputSchema = z.object({
  instructions: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(300_000),
  // Non-interactive flags are always injected by buildClaudeCodeCliArgs (--print, permission bypass).
  // Claude Code CLI does not support --yes/-y; those aliases are stripped if supplied.
  extraArgs: z
    .array(z.string())
    .default(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]),
  docker: DockerSandboxOptionsSchema.nullable().default(null),
});

export interface ClaudeCodeEscalationOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}


export function createClaudeCodeEscalationTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description:
      "LAST-RESORT: invokes Claude Code CLI inside the sandbox. Requires `claude` on PATH (npm i -g @anthropic-ai/claude-code) and ANTHROPIC_API_KEY.",
    inputSchema: ClaudeCodeEscalationInputSchema,
    execute: async ({ instructions, timeoutMs, extraArgs, docker }): Promise<ClaudeCodeEscalationOutput> => {
      const availability = await checkClaudeCodeAvailability();
      if (!availability.available) {
        return {
          exitCode: 127,
          stdout: "",
          stderr: `[execute_claude_code_escalation] Claude Code unavailable: ${availability.reason ?? "unknown"}`,
          timedOut: false,
          durationMs: 0,
        };
      }

      const absoluteSandboxRoot = resolveSandboxPath(sandboxRoot, ".");
      const baseArgs = buildClaudeCodeCliArgs(instructions, extraArgs);
      const containerName = `mams-escalation-${Date.now()}`;
      const binary = availability.binary;
      const claudeSpawnEnv = buildClaudeCodeSpawnEnv();
      const containerEnv = { ...buildClaudeCodeContainerEnv() };
      if (claudeSpawnEnv.ANTHROPIC_API_KEY && !containerEnv.ANTHROPIC_API_KEY) {
        containerEnv.ANTHROPIC_API_KEY = claudeSpawnEnv.ANTHROPIC_API_KEY;
      }

      const invocation = docker
        ? buildDockerInvocation(
            absoluteSandboxRoot,
            ".",
            docker,
            binary,
            baseArgs,
            containerName,
            containerEnv
          )
        : { command: binary, args: baseArgs };

      const result = await runProcess(
        invocation.command,
        invocation.args,
        absoluteSandboxRoot,
        timeoutMs,
        "execute_claude_code_escalation",
        Boolean(docker),
        claudeSpawnEnv
      );
      return result;
    },
  });
}

export function createListChangedFilesTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description:
      "Lists changed files in the workspace (meaningful source paths only; excludes lockfiles and node_modules).",
    inputSchema: z.object({}).default({}),
    execute: async (): Promise<{ readonly paths: readonly string[]; readonly meaningfulOnly: true }> => {
      const realRoot = assertSandboxRootIsContained(sandboxRoot);
      const changes = await collectWorkspaceChanges(createSandboxGitRunner(realRoot));
      return { paths: changes.meaningfulPaths, meaningfulOnly: true };
    },
  });
}

export function createSandboxGitRunner(cwd: string): GitProcessRunner {
  return {
    run: async (args, label, timeoutMs = 120_000) => {
      const result = await runProcess("git", args, cwd, timeoutMs, label);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

export interface ToolSet {
  readonly write_file: ReturnType<typeof createWriteFileTool>;
  readonly read_file: ReturnType<typeof createReadFileTool>;
  readonly read_file_slice: ReturnType<typeof createReadFileSliceTool>;
  readonly search_files: ReturnType<typeof createSearchFilesTool>;
  readonly list_changed_files: ReturnType<typeof createListChangedFilesTool>;
  readonly run_local_tests: ReturnType<typeof createRunLocalTestsTool>;
  readonly execute_claude_code_escalation: ReturnType<typeof createClaudeCodeEscalationTool>;
}

export function createToolSet(sandboxRoot: string): ToolSet {
  return {
    write_file: createWriteFileTool(sandboxRoot),
    read_file: createReadFileTool(sandboxRoot),
    read_file_slice: createReadFileSliceTool(sandboxRoot),
    search_files: createSearchFilesTool(sandboxRoot),
    list_changed_files: createListChangedFilesTool(sandboxRoot),
    run_local_tests: createRunLocalTestsTool(sandboxRoot),
    execute_claude_code_escalation: createClaudeCodeEscalationTool(sandboxRoot),
  };
}

/** @deprecated Prefer buildCleanGitRepoUrl + gitHttpAuthConfigArgs — never persist tokens in git config. */
export function buildAuthenticatedGitCloneUrl(repoUrl: string, token: string): string {
  const parsed = new URL(repoUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`GITHUB_REPO_URL must use HTTPS for token injection; got "${parsed.protocol}".`);
  }
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return `https://${token}@${parsed.host}${path}`;
}

async function runGitCommand(
  args: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = 120_000
): Promise<void> {
  const result = await runProcess("git", args, cwd, timeoutMs, label);
  if (result.exitCode !== 0) {
    const detail = sanitizeSensitiveOutput(result.stderr || result.stdout);
    throw new Error(
      sanitizeSensitiveOutput(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${detail}`)
    );
  }
}

async function runAuthenticatedGitCommand(
  token: string,
  args: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = 120_000
): Promise<void> {
  await runGitCommand([...gitHttpAuthConfigArgs(token), ...args], cwd, label, timeoutMs);
}

function logWorkspaceTelemetry(event: string, payload: Record<string, unknown>): void {
  const sanitizedPayload = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeSensitiveOutput(value) : value,
    ])
  );
  console.warn(`[telemetry] ${JSON.stringify({ event, ...sanitizedPayload })}`);
}

async function runNpmInstall(cwd: string, label: string): Promise<void> {
  if (!existsSync(join(cwd, "package.json"))) {
    return;
  }
  const result = await runProcess(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd,
    600_000,
    label
  );
  if (result.exitCode !== 0) {
    const detail = sanitizeSensitiveOutput(result.stderr || result.stdout).slice(0, 500);
    throw new DependencyInstallError(
      cwd,
      sanitizeSensitiveOutput(`npm install failed (exit ${result.exitCode}): ${detail}`),
      result.exitCode
    );
  }
}

/** Installs dependencies at workspace root and common monorepo packages (server/, next_app/). */
export async function runPostCloneNpmInstall(workspaceRoot: string): Promise<void> {
  const installTargets = [workspaceRoot];
  for (const subdir of ["server", "next_app"]) {
    const pkgPath = join(workspaceRoot, subdir, "package.json");
    if (existsSync(pkgPath)) {
      installTargets.push(join(workspaceRoot, subdir));
    }
  }

  for (const target of installTargets) {
    await runNpmInstall(target, `npm_install_${basename(target)}`);
    console.log(`[workspace] npm install succeeded in "${target}".`);
  }

  await resetLockfileDrift(workspaceRoot, createSandboxGitRunner(workspaceRoot));
}

async function branchNeedsPush(cwd: string, branch: string, token: string): Promise<boolean> {
  const localResult = await runProcess("git", ["rev-parse", branch], cwd, 30_000, "git_rev_parse");
  if (localResult.exitCode !== 0) {
    return true;
  }
  const localHash = localResult.stdout.trim();
  if (!localHash) {
    return true;
  }

  const remoteResult = await runProcess(
    "git",
    [...gitHttpAuthConfigArgs(token), "ls-remote", "--heads", "origin", branch],
    cwd,
    60_000,
    "git_ls_remote"
  );
  if (remoteResult.exitCode !== 0) {
    return true;
  }

  const remoteLine = remoteResult.stdout.trim();
  if (!remoteLine) {
    return true;
  }

  const remoteHash = remoteLine.split(/\s+/)[0] ?? "";
  return remoteHash !== localHash;
}

export interface GitFinalizeResult {
  readonly branch: string;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly meaningfulPaths?: readonly string[];
  readonly skippedReason?: string;
}

/**
 * Clones GITHUB_REPO_URL into the task sandbox (when missing) and configures git identity.
 * Requires validated GEMINI/ANTHROPIC keys plus GITHUB_AUTH_TOKEN and GITHUB_REPO_URL.
 */
export async function initializeGitWorkspace(sandboxRoot: string): Promise<void> {
  const env = loadMamsEnv();
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const cleanCloneUrl = buildCleanGitRepoUrl(env.GITHUB_REPO_URL);
  const gitDir = join(realRoot, ".git");

  if (!existsSync(gitDir)) {
    await runAuthenticatedGitCommand(
      env.GITHUB_AUTH_TOKEN,
      ["clone", cleanCloneUrl, "."],
      realRoot,
      "git_clone"
    );
    await runPostCloneNpmInstall(realRoot);
  }

  await runGitCommand(["config", "user.name", "MAMS Developer Agent"], realRoot, "git_config_name", 30_000);
  await runGitCommand(["config", "user.email", "agent@mams.local"], realRoot, "git_config_email", 30_000);
  await maybeSeedProjectRules(realRoot, env.GITHUB_REPO_URL);
}

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

async function maybeSeedProjectRules(sandboxRoot: string, repoUrl: string): Promise<void> {
  if (!/joinup/i.test(repoUrl)) {
    return;
  }
  const rulesPath = join(sandboxRoot, PROJECT_RULES_FILENAME);
  if (existsSync(rulesPath)) {
    return;
  }
  const seedCandidates = [
    join(TOOLS_DIR, "..", "seeds", "joinup-app.mams-rules.md"),
    join(TOOLS_DIR, "..", "..", "seeds", "joinup-app.mams-rules.md"),
  ];
  const seedPath = seedCandidates.find((candidate) => existsSync(candidate));
  if (!seedPath) {
    return;
  }
  const content = await readFile(seedPath, "utf8");
  await writeFile(rulesPath, content, "utf8");
  console.log(`[workspace] Seeded ${PROJECT_RULES_FILENAME} from JoinUp template.`);
}

export interface GitFinalizeInput {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly coderSummary?: string | null;
}

/**
 * On successful task completion: branch, commit, and push agent changes to GitHub.
 * Failures are logged to telemetry; callers may catch and continue.
 */
export async function finalizeGitWorkspace(
  taskId: TaskId,
  sandboxRoot: string,
  input: GitFinalizeInput
): Promise<GitFinalizeResult> {
  const env = loadMamsEnv();
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const token = env.GITHUB_AUTH_TOKEN;

  const fallbackBranch = `mams/change-${taskId.replace(/-/g, "").slice(0, 8)}`;

  if (!existsSync(join(realRoot, ".git"))) {
    const skippedReason = "no_git_repository";
    logWorkspaceTelemetry("git_finalize_skipped", { taskId, branch: fallbackBranch, skippedReason });
    return { branch: fallbackBranch, committed: false, pushed: false, skippedReason };
  }

  let branch = fallbackBranch;
  try {
    const gitRunner = createSandboxGitRunner(realRoot);
    const changes = await collectWorkspaceChanges(gitRunner);
    const meaningfulPaths = changes.meaningfulPaths;

    if (changes.allPaths.length > 0 && !hasMeaningfulSourceChanges(changes.allPaths)) {
      logWorkspaceTelemetry("git_finalize_skipped", {
        taskId,
        branch: fallbackBranch,
        skippedReason: "no_meaningful_changes",
        noisePaths: changes.allPaths.slice(0, 10),
      });
      return {
        branch: fallbackBranch,
        committed: false,
        pushed: false,
        meaningfulPaths,
        skippedReason: "no_meaningful_changes",
      };
    }

    const gitMetadata = buildGitMetadata({
      taskId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      changedPaths: meaningfulPaths.length > 0 ? meaningfulPaths : changes.allPaths,
      diffText: changes.diffText,
      coderSummary: input.coderSummary ?? null,
    });
    branch = gitMetadata.branch;

    try {
      await runGitCommand(["checkout", "-b", branch], realRoot, "git_checkout_branch");
    } catch {
      await runGitCommand(["checkout", branch], realRoot, "git_checkout_existing");
    }

    const hasUncommittedChanges = changes.allPaths.length > 0;
    let committed = false;

    if (hasUncommittedChanges && meaningfulPaths.length > 0) {
      for (const path of meaningfulPaths) {
        await runGitCommand(["add", "--", path], realRoot, "git_add_path");
      }
      await runGitCommand(
        ["commit", "-m", gitMetadata.commit.subject, "-m", gitMetadata.commit.body],
        realRoot,
        "git_commit"
      );
      committed = true;
    } else if (hasUncommittedChanges) {
      logWorkspaceTelemetry("git_finalize_skipped", {
        taskId,
        branch,
        skippedReason: "only_noise_changes",
      });
      return {
        branch,
        committed: false,
        pushed: false,
        meaningfulPaths,
        skippedReason: "only_noise_changes",
      };
    }

    const needsPush = await branchNeedsPush(realRoot, branch, token);
    if (!needsPush && !committed) {
      logWorkspaceTelemetry("git_finalize_skipped", { taskId, branch, skippedReason: "already_synced" });
      return { branch, committed: false, pushed: true, skippedReason: "already_synced" };
    }

    if (!needsPush && committed) {
      return { branch, committed: true, pushed: true, skippedReason: "already_synced" };
    }

    try {
      await runAuthenticatedGitCommand(
        token,
        ["push", "-u", "origin", branch],
        realRoot,
        "git_push",
        180_000
      );
    } catch (pushErr) {
      logWorkspaceTelemetry("git_push_failed", {
        taskId,
        branch,
        objective: input.objective.slice(0, 200),
        error: pushErr instanceof Error ? pushErr.message : String(pushErr),
      });
      return { branch, committed, pushed: false, skippedReason: "push_failed" };
    }

    console.log(`[workspace] Pushed branch "${branch}" for task "${taskId}".`);
    return { branch, committed, pushed: true, meaningfulPaths };
  } catch (err) {
    logWorkspaceTelemetry("git_finalize_failed", {
      taskId,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
