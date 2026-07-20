// HitlConsole React Component

const { useState } = React;

window.HitlConsole = ({ taskDetail, isTerminalStatus, onAbort, onResume }) => {
  const [userGuidance, setUserGuidance] = useState("");

  const handleResumeClick = () => {
    onResume(userGuidance);
    setUserGuidance("");
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col justify-between h-full">
      <div>
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <window.UserIcon /> Human-in-the-Loop Console
        </h3>
        <p className="text-xs text-gray-400 mt-1">
          Control active pipelines, abort failing runs, or resume escalated tasks with direct instructions.
        </p>

        <div className="mt-4">
          {taskDetail.status === "ESCALATED" && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                <window.AlertTriangleIcon />
                MAMS Agent Requires Input (Escalated)
              </div>
              <p className="text-xs text-gray-300">
                The agent hit a blocking threshold, test budget exhaustion, or is awaiting specification alignment. Review the timeline below and supply guidance to resume the turn.
              </p>
              
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-gray-300">Provide User Guidance / Reply:</label>
                <textarea
                  value={userGuidance}
                  onChange={(e) => setUserGuidance(e.target.value)}
                  placeholder="Tell the agent what to fix, skip, or modify next (e.g. 'Use the mocked auth bypass instead of calling clerk API...')"
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500 min-h-[90px]"
                />
              </div>
            </div>
          )}

          {taskDetail.status !== "ESCALATED" && !taskDetail.orchestrationRunning && !isTerminalStatus(taskDetail.status) && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-xs text-gray-300">
              Task orchestration is currently paused. You can resume it to continue agent execution.
            </div>
          )}

          {taskDetail.orchestrationRunning && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-400 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Agent pipeline actively running...
              </div>
              <span className="text-[10px] text-gray-500 italic">Polling database updates</span>
            </div>
          )}

          {isTerminalStatus(taskDetail.status) && (
            <div className="bg-gray-800/40 border border-gray-800 rounded-xl p-4 text-xs text-gray-405 italic">
              This task is in a terminal status ({taskDetail.status}) and cannot be modified.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 mt-5 pt-3 border-t border-gray-800/50">
        {!isTerminalStatus(taskDetail.status) && (
          <button
            onClick={onAbort}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow"
          >
            <window.SquareIcon /> Abort Task
          </button>
        )}

        {taskDetail.status === "ESCALATED" && (
          <button
            onClick={handleResumeClick}
            disabled={!userGuidance.trim()}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 disabled:opacity-50 disabled:pointer-events-none text-gray-950 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow"
          >
            <window.PlayIcon /> Resume Agent Pipeline
          </button>
        )}

        {taskDetail.status !== "ESCALATED" && !taskDetail.orchestrationRunning && !isTerminalStatus(taskDetail.status) && (
          <button
            onClick={() => onResume("")}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-850 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow"
          >
            <window.PlayIcon /> Resume Pipeline
          </button>
        )}
      </div>
    </div>
  );
};
