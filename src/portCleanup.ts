/**
 * Proactive port cleanup before agent dev-server/test commands (Windows EADDRINUSE).
 */

import { spawn } from "node:child_process";

const DEV_SERVER_HINT =
  /\b(dev|start|serve|next|expo|vite|nodemon|tsx|ts-node|node\s+.*(?:server|index|app))\b/i;

const PORT_PATTERNS: readonly RegExp[] = [
  /--port(?:=|\s+)(\d{2,5})/i,
  /(?:^|\s)-p(?:=|\s+)(\d{2,5})(?:\s|$)/,
  /\bPORT=(\d{2,5})\b/i,
  /:(\d{4,5})\b/,
];

const COMMON_DEV_PORTS: readonly number[] = [3000, 3001, 4000, 5000, 5173, 8080, 8081, 8082];

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: process.platform === "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String(err)}`, exitCode: null });
    });
  });
}

export function extractPortsFromCommand(command: string, args: readonly string[]): number[] {
  const joined = [command, ...args].join(" ");
  const ports = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    for (const match of joined.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      const port = Number(match[1]);
      if (port >= 1 && port <= 65535) {
        ports.add(port);
      }
    }
  }
  if (DEV_SERVER_HINT.test(joined)) {
    for (const port of COMMON_DEV_PORTS) {
      ports.add(port);
    }
  }
  return [...ports];
}

function parseListeningPidsFromNetstat(stdout: string, port: number): number[] {
  const pids = new Set<number>();
  const portToken = `:${port}`;
  for (const line of stdout.split("\n")) {
    if (!line.includes("LISTENING")) {
      continue;
    }
    if (!line.includes(portToken)) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

async function killPidWindows(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  await runCommand("taskkill", ["/F", "/PID", String(pid)], 15_000);
}

async function releasePortWindows(port: number): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const netstat = await runCommand("netstat", ["-ano"], 20_000);
  const pids = parseListeningPidsFromNetstat(netstat.stdout, port);
  await Promise.all(pids.map((pid) => killPidWindows(pid)));
}

/** Releases likely dev-server ports before spawning local test/dev commands. */
export async function releaseDevServerPorts(command: string, args: readonly string[]): Promise<void> {
  const ports = extractPortsFromCommand(command, args);
  if (ports.length === 0) {
    return;
  }
  for (const port of ports) {
    try {
      await releasePortWindows(port);
    } catch {
      // Best-effort cleanup — do not block the agent turn.
    }
  }
}
