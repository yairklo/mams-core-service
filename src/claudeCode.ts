/**
 * Claude Code CLI resolution, non-interactive invocation args, and spawn env.
 *
 * Note: the Claude Code CLI does not support `--yes` / `-y`. Headless automation
 * uses `--print`, `--permission-mode bypassPermissions`, and
 * `--dangerously-skip-permissions` instead.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadMamsEnv, type MamsEnv } from "./env.js";

export interface ClaudeCodeAvailability {
  readonly available: boolean;
  readonly binary: string;
  readonly reason: string | null;
}

/** Flags that keep Claude Code fully non-interactive (no permission prompts). */
export const CLAUDE_CODE_NON_INTERACTIVE_FLAGS = [
  "--permission-mode",
  "bypassPermissions",
  "--dangerously-skip-permissions",
] as const;

const BLOCKED_EXTRA_ARGS = new Set([
  "--print",
  "-p",
  "--yes",
  "-y",
  "--permission-mode",
  "bypassPermissions",
  "--dangerously-skip-permissions",
]);

function runVersionProbe(binary: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], {
      shell: process.platform === "win32",
      windowsHide: true,
      env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, stderr: String(err) });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stderr });
    });
  });
}

/** Resolves Claude Code binary from env or PATH default (`claude`). */
export function resolveClaudeCodeBinary(env: MamsEnv = loadMamsEnv()): string {
  const configured = process.env.CLAUDE_CODE_BINARY?.trim();
  if (configured) {
    return configured;
  }
  return "claude";
}

/**
 * Builds argv for a headless Claude Code run.
 * Always includes `--print` plus permission-bypass flags; ignores duplicate
 * or unsupported `--yes`/`-y` extras from callers.
 */
export function buildClaudeCodeCliArgs(
  instructions: string,
  extraArgs: readonly string[] = []
): readonly string[] {
  const filteredExtras = extraArgs.filter((arg, index, all) => {
    if (BLOCKED_EXTRA_ARGS.has(arg)) {
      return false;
    }
    if (arg === "bypassPermissions" && all[index - 1] === "--permission-mode") {
      return false;
    }
    return true;
  });

  return ["--print", instructions, ...CLAUDE_CODE_NON_INTERACTIVE_FLAGS, ...filteredExtras];
}

/** Keys forwarded into Docker sandbox containers when running Claude Code. */
export function buildClaudeCodeContainerEnv(env: MamsEnv = loadMamsEnv()): Record<string, string> {
  const spawnEnv = buildClaudeCodeSpawnEnv(env);
  const forwarded: Record<string, string> = {};
  for (const key of ["ANTHROPIC_API_KEY", "CI", "CLAUDE_CODE_BINARY"] as const) {
    const value = spawnEnv[key]?.trim();
    if (value) {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

/** Builds env for Claude Code subprocess (inherits full process.env + Anthropic key). */
export function buildClaudeCodeSpawnEnv(env: MamsEnv = loadMamsEnv()): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, CI: process.env.CI ?? "true" };
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    spawnEnv.ANTHROPIC_API_KEY = apiKey;
  }
  return spawnEnv;
}

/** Checks whether Claude Code CLI is invocable on this machine. */
export async function checkClaudeCodeAvailability(
  env: MamsEnv = loadMamsEnv()
): Promise<ClaudeCodeAvailability> {
  const binary = resolveClaudeCodeBinary(env);
  if (binary.includes("/") || binary.includes("\\")) {
    if (!existsSync(binary)) {
      return {
        available: false,
        binary,
        reason: `CLAUDE_CODE_BINARY points to missing path: ${binary}`,
      };
    }
  }

  const probe = await runVersionProbe(binary, buildClaudeCodeSpawnEnv(env));
  if (!probe.ok) {
    return {
      available: false,
      binary,
      reason:
        probe.stderr.trim() ||
        `"${binary}" is not on PATH. Install: npm install -g @anthropic-ai/claude-code`,
    };
  }

  return { available: true, binary, reason: null };
}
