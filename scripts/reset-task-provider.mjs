/**
 * Reset a task to GOOGLE + flash model (fixes stuck ANTHROPIC / quota issues).
 * Usage: node --env-file=.env scripts/reset-task-provider.mjs <taskId> [blueprintStepIndex]
 */
import { loadTaskState, saveTaskState } from "../dist/database.js";

const taskId = process.argv[2];
const stepArg = process.argv[3];

if (!taskId) {
  console.error("Usage: node --env-file=.env scripts/reset-task-provider.mjs <taskId> [blueprintStepIndex]");
  process.exit(1);
}

const state = await loadTaskState(taskId);
if (!state) {
  console.error(`Task not found: ${taskId}`);
  process.exit(1);
}

const blueprintStepIndex =
  stepArg !== undefined && stepArg !== "" ? Number.parseInt(stepArg, 10) : state.blueprintStepIndex;

const next = {
  ...state,
  preferredProvider: "GOOGLE",
  modelOverride: "gemini-1.5-flash-latest",
  status: state.status === "ESCALATED" || state.status === "OPTIMIZING" ? "EXECUTING" : state.status,
  blueprintStepIndex: Number.isFinite(blueprintStepIndex) ? blueprintStepIndex : state.blueprintStepIndex,
};

await saveTaskState(next);
console.log(
  JSON.stringify(
    {
      taskId,
      status: next.status,
      blueprintStepIndex: next.blueprintStepIndex,
      preferredProvider: next.preferredProvider,
      modelOverride: next.modelOverride,
    },
    null,
    2
  )
);
