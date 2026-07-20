// ContractBlueprint React Component

window.ContractBlueprint = ({ taskDetail }) => {
  const objective = taskDetail.objective || "No objective defined.";
  const criteria = taskDetail.acceptanceCriteria || [];
  const blueprintSteps = taskDetail.blueprintSteps || [];
  const currentStepIdx = taskDetail.blueprintStepIndex || 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 bg-gray-900 border border-gray-800 rounded-2xl p-5">
      {/* Task Contract */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <svg className="h-5 w-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Task Objective & Criteria
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">Primary requirements and specifications of this task.</p>
        </div>

        {/* Objective */}
        <div className="bg-gray-950/80 border border-gray-850 p-4 rounded-xl">
          <span className="text-[10px] uppercase font-semibold text-gray-500 tracking-wider block mb-1">Objective</span>
          <p className="text-sm text-gray-250 leading-relaxed font-sans">{objective}</p>
        </div>

        {/* Acceptance Criteria */}
        <div className="space-y-2">
          <span className="text-[10px] uppercase font-semibold text-gray-550 tracking-wider block">Acceptance Criteria</span>
          <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
            {criteria.map((item, idx) => (
              <div key={idx} className="flex items-start gap-2 text-xs text-gray-300">
                <svg className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span>{item}</span>
              </div>
            ))}
            {criteria.length === 0 && (
              <span className="text-xs text-gray-500 italic">No acceptance criteria defined</span>
            )}
          </div>
        </div>
      </div>

      {/* Blueprint Steps Progress */}
      <div className="space-y-4 border-t lg:border-t-0 lg:border-l border-gray-800 pt-4 lg:pt-0 lg:pl-6 flex flex-col justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <svg className="h-5 w-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Blueprint Step Progress
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">Checklist of modular steps parsed from task-blueprint.md.</p>
        </div>

        <div className="flex-1 overflow-y-auto max-h-[220px] mt-3 space-y-2 pr-1">
          {blueprintSteps.map((stepText, idx) => {
            const isCompleted = idx < currentStepIdx;
            const isActive = idx === currentStepIdx;
            const isPending = idx > currentStepIdx;

            let borderStyle = "border-gray-850 bg-gray-950/40 text-gray-450";
            if (isActive) borderStyle = "border-blue-500/50 bg-blue-950/10 text-white font-medium shadow-sm shadow-blue-500/5";
            if (isCompleted) borderStyle = "border-emerald-500/10 bg-emerald-950/5 text-gray-400 line-through";

            return (
              <div key={idx} className={"flex items-center justify-between p-2.5 rounded-lg border text-xs transition " + borderStyle}>
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Status checkbox indicator */}
                  {isCompleted && (
                    <svg className="h-4 w-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {isActive && (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                  )}
                  {isPending && (
                    <span className="h-2 w-2 rounded-full bg-gray-700 shrink-0"></span>
                  )}
                  <span className="truncate">{idx + 1 + ". " + stepText}</span>
                </div>

                {/* Status Badges */}
                <div>
                  {isCompleted && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded border border-emerald-500/20 shrink-0">
                      Done
                    </span>
                  )}
                  {isActive && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30 shrink-0 animate-pulse">
                      Active
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {blueprintSteps.length === 0 && (
            <div className="text-center py-6 text-gray-600 italic text-xs">
              Blueprint step checklist will generate once the planning phase begins.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
