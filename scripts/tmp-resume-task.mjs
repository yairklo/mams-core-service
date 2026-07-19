/**
 * Resume orchestration for an existing non-terminal task.
 * Usage: node scripts/tmp-resume-task.mjs <taskId>
 */

import { StateMachine } from "../dist/fsmEngine.js";
import { runTaskOrchestration } from "../dist/orchestration.js";
import { AGENT_WORKSPACES_BASE_DIR, assertSandboxRootIsContained } from "../dist/tools.js";
import { asTaskId } from "../dist/types.js";
import { join } from "node:path";

const taskIdRaw = process.argv[2];
if (!taskIdRaw) {
  console.error("Usage: node scripts/tmp-resume-task.mjs <taskId>");
  process.exit(1);
}

const taskId = asTaskId(taskIdRaw);
const sandboxRoot = assertSandboxRootIsContained(join(AGENT_WORKSPACES_BASE_DIR, taskId));

const sm = new StateMachine();
const state = await sm.getTaskState(taskId);
console.log(`Resuming task ${taskId} (status=${state.status})`);
await runTaskOrchestration(sm, taskId, sandboxRoot);
const finalState = await sm.getTaskState(taskId);
console.log(`Finished orchestration loop. status=${finalState.status}`);
