/**
 * Tool implementations for the MAMS execution plane.
 * Every file/process operation is confined to AGENT_WORKSPACES_BASE_DIR.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadMamsEnv, MamsEnvSchema, type MamsEnv } from "./env.js";
import { registerChildProcess, registerDockerContainerId } from "./processRegistry.js";

export { MamsEnvSchema, loadMamsEnv, type MamsEnv };

// From dist/tools.js -> ../workspaces = mams-core-service/workspaces/
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
        stdout,
        stderr: stderr + `\n[run_process] Failed to spawn "${command}": ${String(err)}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      settle({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
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

/** Builds an authenticated HTTPS clone URL for headless VPS git operations. */
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
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
    );
  }
}

/**
 * Clones GITHUB_REPO_URL into the task sandbox (when missing) and configures git identity.
 * Requires validated GEMINI/ANTHROPIC keys plus GITHUB_AUTH_TOKEN and GITHUB_REPO_URL.
 */
export async function initializeGitWorkspace(sandboxRoot: string): Promise<void> {
  const env = loadMamsEnv();
  const realRoot = assertSandboxRootIsContained(sandboxRoot);
  const cloneUrl = buildAuthenticatedGitCloneUrl(env.GITHUB_REPO_URL, env.GITHUB_AUTH_TOKEN);
  const gitDir = join(realRoot, ".git");

  if (!existsSync(gitDir)) {
    await runGitCommand(["clone", cloneUrl, "."], realRoot, "git_clone");
  }

  await runGitCommand(["config", "user.name", "MAMS Developer Agent"], realRoot, "git_config_name", 30_000);
  await runGitCommand(["config", "user.email", "agent@mams.local"], realRoot, "git_config_email", 30_000);
}
