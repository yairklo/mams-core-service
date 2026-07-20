/**
 * Polls a MAMS task and auto-resumes / auto-approves until terminal.
 * Usage: node scripts/task-monitor.mjs <taskId> [baseUrl]
 */
const taskId = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:8080";
const TERMINAL = new Set(["DONE", "FAILED", "ABORTED", "ABORTED_FUSE", "CANCELLED"]);

if (!taskId) {
  console.error("Usage: node scripts/task-monitor.mjs <taskId>");
  process.exit(1);
}

async function getTask() {
  const res = await fetch(`${baseUrl}/api/mams/task/${taskId}`);
  if (!res.ok) throw new Error(`GET task failed: ${res.status}`);
  return res.json();
}

async function resume() {
  const res = await fetch(`${baseUrl}/api/mams/task/${taskId}/resume`, { method: "POST" });
  return res.json();
}

async function approve() {
  const res = await fetch(`${baseUrl}/api/mams/task/${taskId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "task-monitor" }),
  });
  return res.json();
}

async function tick() {
  const t = await getTask();
  const lp = t.runtime?.liveProgress ?? {};
  const blueprint =
    t.blueprintTotalSteps > 0
      ? `${t.blueprintStepIndex + 1}/${t.blueprintTotalSteps}`
      : "n/a";
  const line = `[${new Date().toISOString()}] status=${t.status} orch=${t.orchestrationRunning} blueprint=${blueprint} role=${lp.currentRole ?? "-"} tool=${lp.lastTool?.toolName ?? "-"}`;
  console.log(line);

  if (TERMINAL.has(t.status)) {
    console.log(`TERMINAL:${t.status}`);
    return "done";
  }

  if (t.status === "ESCALATED" && !t.orchestrationRunning) {
    const r = await approve();
    console.log(`  -> approve: ${JSON.stringify(r)}`);
    return "acted";
  }

  if (!t.orchestrationRunning && t.status !== "AWAITING_APPROVAL") {
    const r = await resume();
    if (r.error === "Orchestration is already running for this task.") {
      return "wait";
    }
    console.log(`  -> resume: ${JSON.stringify(r)}`);
    return "acted";
  }

  return "wait";
}

async function main() {
  for (let i = 0; i < 500; i += 1) {
    try {
      const outcome = await tick();
      if (outcome === "done") {
        process.exit(0);
      }
    } catch (err) {
      console.error(`[monitor] error: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  console.log("TERMINAL:TIMEOUT");
  process.exit(2);
}

void main();
