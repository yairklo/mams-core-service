/**
 * Manual end-to-end smoke entry point for the MAMS pipeline.
 *
 * Usage:
 *   npm run smoke              # runs orchestration in-process (Tier 2)
 *   npm run smoke -- --http    # POST to running server instead
 *   npm run smoke -- --curl    # print curl command only
 */

import { randomUUID } from "node:crypto";

import { loadMamsEnv } from "./env.js";
import { PrismaFiscalBudgetLedger, StateMachine } from "./fsmEngine.js";
import { disconnectDatabase } from "./database.js";
import { runTaskOrchestration } from "./orchestration.js";
import { AGENT_WORKSPACES_BASE_DIR, assertSandboxRootIsContained } from "./tools.js";
import { asSessionId, asTaskId } from "./types.js";
import { join } from "node:path";

const DEFAULT_OBJECTIVE =
  "Smoke test: verify MAMS can clone the JoinUp repo, install dependencies, and orchestrate a Tier 2 task.";

async function runInProcess(objective: string): Promise<void> {
  const env = loadMamsEnv();
  const sm = new StateMachine({
    fiscalBudgetLedger: new PrismaFiscalBudgetLedger(env.MAMS_FISCAL_BUDGET_LIMIT_USD),
  });

  const taskId = asTaskId(randomUUID());
  const sessionId = asSessionId(`smoke-${Date.now()}`);
  const now = Date.now();

  console.log(`[smoke] Creating Tier 2 task "${taskId}"...`);
  console.log(`[smoke] GITHUB_REPO_URL=${env.GITHUB_REPO_URL}`);

  await sm.createTask({
    taskId,
    sessionId,
    contract: {
      taskId,
      objective,
      acceptanceCriteria: ["Pipeline completes without orchestrator crash"],
      groundTruthArtifacts: [],
      createdAt: now,
      immutableHash: "smoke-test",
    },
    costScopeId: `smoke-scope-${taskId}`,
    deadline: { absoluteMs: now + env.MAMS_DEFAULT_DEADLINE_MS, softWarnAtRatio: 0.8 },
    executionTier: "TIER2_STANDARD",
    pmContext: {
      initialRequest: { source: "smokeTestRunner" },
      clarifyingQuestions: [],
      developerReplies: ["Run full Tier 2 orchestration against cloned workspace."],
    },
  });

  console.log(`[smoke] Task created — starting orchestration...`);
  await runTaskOrchestration(sm, taskId, assertSandboxRootIsContained(join(AGENT_WORKSPACES_BASE_DIR, taskId)));

  const finalState = await sm.getTaskState(taskId);
  console.log("[smoke] Final task state:");
  console.log(JSON.stringify({ taskId: finalState.taskId, status: finalState.status, history: finalState.history }, null, 2));
}

async function runViaHttp(objective: string, port: number): Promise<void> {
  const body = {
    objective,
    executionTier: "TIER2_STANDARD",
    acceptanceCriteria: ["Pipeline completes without orchestrator crash"],
    pmContext: {
      initialRequest: { source: "smokeTestRunner" },
      developerReplies: ["Triggered via HTTP smoke runner."],
    },
  };

  const url = `http://127.0.0.1:${port}/api/mams/task/start`;
  console.log(`[smoke] POST ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  console.log(`[smoke] HTTP ${response.status}:`, JSON.stringify(payload, null, 2));

  if (!response.ok) {
    throw new Error(`Smoke HTTP trigger failed with status ${response.status}`);
  }
}

function printCurlCommand(objective: string, port: number): void {
  const body = JSON.stringify({
    objective,
    executionTier: "TIER2_STANDARD",
    acceptanceCriteria: ["Pipeline completes without orchestrator crash"],
    pmContext: { initialRequest: { source: "curl" } },
  });

  console.log(`curl -X POST http://127.0.0.1:${port}/api/mams/task/start \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '${body.replace(/'/g, "'\\''")}'`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const objective = process.env.MAMS_SMOKE_OBJECTIVE ?? DEFAULT_OBJECTIVE;
  const env = loadMamsEnv();
  const port = env.PORT;

  if (args.includes("--curl")) {
    printCurlCommand(objective, port);
    return;
  }

  if (args.includes("--http")) {
    await runViaHttp(objective, port);
    return;
  }

  await runInProcess(objective);
}

main()
  .catch((err) => {
    console.error("[smoke] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => undefined);
  });
