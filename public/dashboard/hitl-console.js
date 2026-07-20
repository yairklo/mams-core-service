// HitlConsole React Component

const { useState } = React;

window.HitlConsole = ({ taskDetail, isTerminalStatus, onAbort, onResume }) => {
  const [userGuidance, setUserGuidance] = useState("");

  const handleResumeClick = () => {
    onResume(userGuidance);
    setUserGuidance("");
  };

  const isEscalated = taskDetail.status === "ESCALATED";
  const isRunning = taskDetail.orchestrationRunning;
  const isTerminal = isTerminalStatus(taskDetail.status);
  const canSendGuidance = isEscalated && userGuidance.trim();

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col justify-between h-full">
      <div>
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <window.UserIcon /> Human-in-the-Loop Console
        </h3>
        <p className="text-xs text-gray-400 mt-1">
          Control active pipelines, abort failing runs, or provide guidance when the agent escalates.
        </p>

        {/* Status banner */}
        <div className="mt-4">
          {isEscalated && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 flex items-center gap-2 text-amber-400 font-semibold text-sm">
              <window.AlertTriangleIcon />
              Agent escalated — awaiting your input
            </div>
          )}
          {isRunning && !isEscalated && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-400 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Agent pipeline actively running...
              </div>
              <span className="text-[10px] text-gray-500 italic">Polling live</span>
            </div>
          )}
          {isTerminal && (
            <div className="bg-gray-800/40 border border-gray-800 rounded-xl p-3 text-xs text-gray-500 italic">
              Task reached terminal status ({taskDetail.status}).
            </div>
          )}
        </div>

        {/* Guidance textarea — always visible unless terminal */}
        {!isTerminal && (
          <div className="mt-4 space-y-1.5">
            <label className="text-xs font-medium text-gray-300 flex items-center gap-1.5">
              {isEscalated
                ? "✍️ Provide guidance to resume the agent:"
                : "📋 Pre-write guidance for when the agent escalates:"}
            </label>
            <textarea
              value={userGuidance}
              onChange={(e) => setUserGuidance(e.target.value)}
              placeholder={
                isEscalated
                  ? "Tell the agent what to fix, skip, or modify (e.g. 'Use read_file_slice, build the change in memory, then write_file with the full updated file content')..."
                  : "Write guidance here now — it will be sent when you click Resume after escalation..."
              }
              className={
                "w-full bg-gray-950 border rounded-lg p-2.5 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 min-h-[100px] transition " +
                (isEscalated
                  ? "border-amber-600/40 focus:ring-amber-500"
                  : "border-gray-800 focus:ring-blue-500")
              }
            />
            {!isEscalated && userGuidance.trim() && (
              <p className="text-[10px] text-gray-500 italic">
                ℹ️ Guidance is saved locally — click "Resume Agent Pipeline" after escalation to send it.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-3 mt-5 pt-3 border-t border-gray-800/50">
        {!isTerminal && (
          <button
            onClick={onAbort}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow"
          >
            <window.SquareIcon /> Abort Task
          </button>
        )}

        {isEscalated && (
          <button
            onClick={handleResumeClick}
            disabled={!canSendGuidance}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 disabled:opacity-40 disabled:pointer-events-none text-gray-950 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow"
          >
            <window.PlayIcon /> Resume Agent Pipeline
          </button>
        )}

        {!isEscalated && !isRunning && !isTerminal && (
          <button
            onClick={() => onResume("")}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow"
          >
            <window.PlayIcon /> Resume Pipeline
          </button>
        )}
      </div>
    </div>
  );
};
