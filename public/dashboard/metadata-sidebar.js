// MetadataSidebar React Component

window.MetadataSidebar = ({ taskDetail, getStatusColor }) => {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-lg font-bold text-white flex items-center gap-2">
        <window.TerminalIcon /> Pipeline Metadata
      </h3>
      
      <div className="space-y-3 text-sm">
        <div className="flex justify-between py-1 border-b border-gray-850/50">
          <span className="text-gray-400">Task ID</span>
          <span className="font-mono text-xs text-gray-300 select-all">{taskDetail.taskId}</span>
        </div>
        <div className="flex justify-between py-1 border-b border-gray-855/50">
          <span className="text-gray-400">Current Status</span>
          <span className={"text-xs font-semibold px-2 py-0.5 border rounded-full " + getStatusColor(taskDetail.status)}>
            {taskDetail.status}
          </span>
        </div>
        <div className="flex justify-between py-1 border-b border-gray-855/50">
          <span className="text-gray-400">Execution Tier</span>
          <span className="text-gray-200 font-medium">{taskDetail.executionTier}</span>
        </div>
        <div className="flex justify-between py-1 border-b border-gray-855/50">
          <span className="text-gray-400">Orchestrator Thread</span>
          <span className="flex items-center gap-1.5">
            <span className={"h-2.5 w-2.5 rounded-full " + (taskDetail.orchestrationRunning ? "bg-emerald-500 animate-ping" : "bg-gray-600")}></span>
            <span className="text-gray-300 font-medium">{taskDetail.orchestrationRunning ? "RUNNING" : "PAUSED"}</span>
          </span>
        </div>
        <div className="flex justify-between py-1 border-b border-gray-855/50">
          <span className="text-gray-400">Blueprint Progress</span>
          <span className="text-gray-300 font-mono">
            {taskDetail.blueprintStepIndex + " / " + taskDetail.blueprintTotalSteps + " steps"}
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      {taskDetail.blueprintTotalSteps > 0 && (
        <div className="space-y-1.5 pt-2">
          <div className="flex justify-between text-xs text-gray-400">
            <span>Blueprint Step Progress</span>
            <span>{taskDetail.liveProgress.percent + "%"}</span>
          </div>
          <div className="w-full bg-gray-950 h-2 rounded-full overflow-hidden border border-gray-800">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-500"
              style={{ width: taskDetail.liveProgress.percent + "%" }}
            ></div>
          </div>
        </div>
      )}

      {/* Recent Tools */}
      <div className="pt-2">
        <span className="text-xs font-semibold text-gray-400 block mb-2">Recent Tools Invocations</span>
        <div className="flex flex-wrap gap-1.5">
          {taskDetail.recentTools.map((tool, idx) => (
            <span key={idx} className="text-[10px] bg-gray-950 border border-gray-800 px-2 py-0.5 rounded font-mono text-gray-300">
              {tool}
            </span>
          ))}
          {taskDetail.recentTools.length === 0 && (
            <span className="text-xs text-gray-655 italic">No tools run yet</span>
          )}
        </div>
      </div>
    </div>
  );
};
