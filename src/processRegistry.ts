/**
 * Global registry of every child process and Docker invocation spawned by MAMS
 * tools. Used by server.ts graceful-shutdown handlers to prevent orphan zombie
 * processes when the service receives SIGTERM/SIGINT.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface TrackedProcess {
  readonly pid: number;
  readonly label: string;
  readonly startedAtMs: number;
  readonly isDocker: boolean;
}

const activeProcesses = new Map<number, TrackedProcess>();
const activeDockerContainerIds = new Set<string>();

export function registerChildProcess(child: ChildProcess, label: string, isDocker = false): void {
  if (child.pid === undefined) {
    return;
  }
  activeProcesses.set(child.pid, { pid: child.pid, label, startedAtMs: Date.now(), isDocker });

  const unregister = (): void => {
    if (child.pid !== undefined) {
      activeProcesses.delete(child.pid);
    }
  };
  child.once("exit", unregister);
  child.once("error", unregister);
}

export function registerDockerContainerId(containerId: string): void {
  if (containerId.trim().length > 0) {
    activeDockerContainerIds.add(containerId.trim());
  }
}

export function getActiveProcessSnapshot(): readonly TrackedProcess[] {
  return Array.from(activeProcesses.values());
}

export async function killAllTrackedProcesses(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  for (const tracked of activeProcesses.values()) {
    try {
      process.kill(tracked.pid, signal);
    } catch {
      // Process may have already exited between snapshot and kill.
    }
  }
}

export async function cleanupDockerContainers(): Promise<void> {
  if (activeDockerContainerIds.size === 0) {
    return;
  }

  await Promise.all(
    Array.from(activeDockerContainerIds).map(
      (containerId) =>
        new Promise<void>((resolve) => {
          const killer = spawn("docker", ["rm", "-f", containerId], { shell: false });
          killer.on("close", () => resolve());
          killer.on("error", () => resolve());
        })
    )
  );
  activeDockerContainerIds.clear();
}

export async function gracefulProcessShutdown(): Promise<void> {
  await killAllTrackedProcesses("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  await killAllTrackedProcesses("SIGKILL");
  await cleanupDockerContainers();
  activeProcesses.clear();
}
