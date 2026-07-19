/**
 * Tool implementations for the MAMS execution plane.
 * Every file/process operation is confined to AGENT_WORKSPACES_BASE_DIR.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskId } from "./types.js";
import { tool } from "ai";
import { z } from "zod";
import { loadMamsEnv, MamsEnvSchema, type MamsEnv } from "./env.js";
import { registerChildProcess, registerDockerContainerId } from "./processRegistry.js";

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

/** Parses numbered/checklist steps from `task-blueprint.md`. */
export async function readBlueprintSteps(sandboxRoot: string): Promise<readonly string[]> {
  try {
    const blueprintPath = resolveSandboxPath(sandboxRoot, TASK_BLUEPRINT_FILENAME);
    const content = await readFile(blueprintPath, "utf8");
    const steps: string[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*(?:\d+[\.)]|[-*])\s+(.+)$/);
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

export async function validateArchitectureArtifacts(sandboxRoot: string): Promise<boolean> {
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

export interface ReadFileOutput {
  readonly path: string;
  readonly content: string;
}

export function createReadFileTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description: "Reads a UTF-8 text file within the task sandbox.",
    inputSchema: ReadFileInputSchema,
    execute: async ({ path }): Promise<ReadFileOutput> => {
      const absolutePath = resolveSandboxPath(sandboxRoot, path);
      const content = await readFile(absolutePath, "utf8");
      return { path, content };
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

const MAX_CAPTURED_OUTPUT_BYTES = 512 * 1024;

function buildDockerInvocation(
  absoluteSandboxRoot: string,
  cwd: string,
  docker: DockerSandboxOptions,
  command: string,
  args: readonly string[],
  containerName: string
): { readonly command: string; readonly args: readonly string[] } {
  const containerWorkdir = (cwd === "." ? "/workspace" : `/workspace/${cwd}`).replace(/\/+$/, "") || "/workspace";
  registerDockerContainerId(containerName);
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

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  label: string,
  isDocker = false
): Promise<RunLocalTestsOutput> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, shell: false });
    registerChildProcess(child, label, isDocker);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const appendBounded = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_CAPTURED_OUTPUT_BYTES ? buf : buf + chunk.toString("utf8");

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
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
        stdout: sanitizeSensitiveOutput(stdout),
        stderr: sanitizeSensitiveOutput(
          stderr + `\n[run_process] Failed to spawn "${command}": ${String(err)}`
        ),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      settle({
        exitCode: code,
        stdout: sanitizeSensitiveOutput(stdout),
        stderr: sanitizeSensitiveOutput(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
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
  extraArgs: z.array(z.string()).default(["--dangerously-skip-permissions"]),
  docker: DockerSandboxOptionsSchema.nullable().default(null),
});

export interface ClaudeCodeEscalationOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

const CLAUDE_CODE_BINARY = "claude";

export function createClaudeCodeEscalationTool(sandboxRoot: string) {
  assertSandboxRootIsContained(sandboxRoot);
  return tool({
    description: "LAST-RESORT: invokes Claude Code CLI inside the sandbox to resolve deadlocks.",
    inputSchema: ClaudeCodeEscalationInputSchema,
    execute: async ({ instructions, timeoutMs, extraArgs, docker }): Promise<ClaudeCodeEscalationOutput> => {
      const absoluteSandboxRoot = resolveSandboxPath(sandboxRoot, ".");
      const baseArgs = ["--print", instructions, ...extraArgs];
      const containerName = `mams-escalation-${Date.now()}`;

      const invocation = docker
        ? buildDockerInvocation(absoluteSandboxRoot, ".", docker, CLAUDE_CODE_BINARY, baseArgs, containerName)
        : { command: CLAUDE_CODE_BINARY, args: baseArgs };

      return runProcess(
        invocation.command,
        invocation.args,
        absoluteSandboxRoot,
        timeoutMs,
        "execute_claude_code_escalation",
        Boolean(docker)
      );
    },
  });
}

export interface ToolSet {
  readonly write_file: ReturnType<typeof createWriteFileTool>;
  readonly read_file: ReturnType<typeof createReadFileTool>;
  readonly run_local_tests: ReturnType<typeof createRunLocalTestsTool>;
  readonly execute_claude_code_escalation: ReturnType<typeof createClaudeCodeEscalationTool>;
}

export function createToolSet(sandboxRoot: string): ToolSet {
  return {
    write_file: createWriteFileTool(sandboxRoot),
    read_file: createReadFileTool(sandboxRoot),
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
    ["install", "--no-audit", "--no-fund"],
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
}

/**
 * On successful task completion: branch, commit, and push agent changes to GitHub.
 * Failures are logged to telemetry; callers may catch and continue.
 */
export async function finalizeGitWorkspace(
  taskId: TaskId,
  sandboxRoot: string,
  objective: string
): Promise<GitFinalizeResult> {
  const env = loadMamsEnv();
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const branch = `mams/task-${taskId}`;
  const token = env.GITHUB_AUTH_TOKEN;

  if (!existsSync(join(realRoot, ".git"))) {
    const skippedReason = "no_git_repository";
    logWorkspaceTelemetry("git_finalize_skipped", { taskId, branch, skippedReason });
    return { branch, committed: false, pushed: false, skippedReason };
  }

  try {
    try {
      await runGitCommand(["checkout", "-b", branch], realRoot, "git_checkout_branch");
    } catch {
      await runGitCommand(["checkout", branch], realRoot, "git_checkout_existing");
    }

    const statusResult = await runProcess(
      "git",
      ["status", "--porcelain"],
      realRoot,
      30_000,
      "git_status"
    );
    if (statusResult.exitCode !== 0) {
      throw new Error(
        sanitizeSensitiveOutput(`git status failed: ${statusResult.stderr || statusResult.stdout}`)
      );
    }

    const hasUncommittedChanges = statusResult.stdout.trim().length > 0;
    let committed = false;

    if (hasUncommittedChanges) {
      await runGitCommand(["add", "."], realRoot, "git_add");
      await runGitCommand(["commit", "-m", "feat(mams): auto-implemented objective"], realRoot, "git_commit");
      committed = true;
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
        objective: objective.slice(0, 200),
        error: pushErr instanceof Error ? pushErr.message : String(pushErr),
      });
      return { branch, committed, pushed: false, skippedReason: "push_failed" };
    }

    console.log(`[workspace] Pushed branch "${branch}" for task "${taskId}".`);
    return { branch, committed, pushed: true };
  } catch (err) {
    logWorkspaceTelemetry("git_finalize_failed", {
      taskId,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
