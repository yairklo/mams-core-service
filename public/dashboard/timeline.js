// Timeline React Component

const { useState } = React;

const getToolCallSummary = (toolName, args) => {
  if (!args) return "Executing " + toolName;
  switch (toolName) {
    case "read_file":
      return "📖 Reading file: " + (args.path || "");
    case "read_file_slice":
      return "📄 Reading lines " + (args.startLine || 1) + " to " + ((args.startLine || 1) + (args.lineCount || 0)) + " of " + (args.path || "");
    case "write_file":
      return "💾 Writing/Updating file: " + (args.path || "");
    case "search_files":
      return "🔍 Searching for query '" + (args.query || "") + "'" + (args.pathPrefix ? " in " + args.pathPrefix : "");
    case "run_local_tests":
      return "🧪 Running test: " + (args.command || "") + " " + (args.args ? (Array.isArray(args.args) ? args.args.join(" ") : args.args) : "");
    case "list_changed_files":
      return "🌿 Checking for changed files in git workspace";
    default:
      return "⚙️ Executing tool: " + toolName;
  }
};

window.Timeline = ({ steps, getRoleColor, blueprintSteps }) => {
  const [expandedSteps, setExpandedSteps] = useState({});

  const toggleStep = (stepId) => {
    setExpandedSteps((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-6">
      <div>
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <window.TerminalIcon /> Execution Timeline & Step Feed
        </h3>
        <p className="text-xs text-gray-400 mt-1">
          Chronological order of actions taken by autonomous agent instances on this workspace.
        </p>
      </div>

      <div className="relative border-l border-gray-800 ml-4 pl-6 space-y-8">
        {steps.map((step) => {
          const stepId = step.stepId;
          const isExpanded = !!expandedSteps[stepId];
          const timestamp = new Date(step.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          return (
            <div key={stepId} className="relative">
              <span className="absolute -left-[31px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 border border-gray-700">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500"></span>
              </span>

              <div className="bg-gray-950 border border-gray-850 rounded-xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-900 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-400">{"#" + (step.stepIndex + 1)}</span>
                    <span className={"text-[10px] font-bold px-2 py-0.5 border rounded " + getRoleColor(step.role)}>
                      {step.role}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">{"(" + step.agentId + ")"}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1 font-mono text-[10px] bg-gray-900 px-2 py-0.5 rounded">
                      <window.CoinsIcon /> {"$" + (step.usage?.estimatedCostUsd || 0).toFixed(4)}
                    </span>
                    <span className="flex items-center gap-1 font-mono text-[10px] bg-gray-900 px-2 py-0.5 rounded text-gray-450" title="Tokens (Input / Output)">
                      In: {(step.usage?.inputTokens || 0).toLocaleString()} | Out: {(step.usage?.outputTokens || 0).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1 font-mono text-[10px] bg-gray-900 px-2 py-0.5 rounded">
                      {step.usage?.modelId || "unknown"}
                    </span>
                    <span className="flex items-center gap-1">
                      <window.ClockIcon /> {timestamp}
                    </span>
                  </div>
                </div>

                {/* Blueprint Step Context */}
                {step.usage && typeof step.usage.blueprintStepIndex === "number" && blueprintSteps && blueprintSteps[step.usage.blueprintStepIndex] && (
                  <div className="bg-blue-500/10 border border-blue-500/20 text-blue-300 rounded-lg p-2.5 text-xs flex items-center gap-2">
                    <svg className="h-4 w-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <span>
                      <span className="font-semibold text-blue-400">Blueprint Target:</span>{" "}
                      {blueprintSteps[step.usage.blueprintStepIndex]}
                    </span>
                  </div>
                )}

                <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                  {step.narrativeSummary}
                </div>

                {step.toolCalls && step.toolCalls.length > 0 && (
                  <div className="pt-2">
                    <button
                      onClick={() => toggleStep(stepId)}
                      className="text-xs text-blue-400 hover:text-blue-300 font-semibold flex items-center gap-1.5 focus:outline-none"
                    >
                      {isExpanded ? (
                        <span className="flex items-center gap-1">Hide Tool Activity <window.ChevronUpIcon /></span>
                      ) : (
                        <span className="flex items-center gap-1">Show Tool Activity {"(" + step.toolCalls.length + " calls)"} <window.ChevronDownIcon /></span>
                      )}
                    </button>

                    {isExpanded && (
                      <div className="mt-3 space-y-2.5">
                        {step.toolCalls.map((call, cIdx) => (
                          <div
                            key={cIdx}
                            className={"p-3 rounded-lg border text-xs font-mono space-y-2 " + (
                              call.ok
                                ? "bg-gray-900/60 border-gray-800 text-gray-300"
                                : "bg-rose-955/20 border-rose-900/50 text-rose-300"
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-gray-200">
                                {getToolCallSummary(call.toolName, call.args)}
                              </span>
                              <span className="flex items-center gap-1">
                                {call.ok ? <window.CheckCircleIcon /> : <window.XCircleIcon />}
                                {call.ok ? "Success" : "Failed"}
                              </span>
                            </div>

                            {call.reasoning && (
                              <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-950/20 border border-amber-700/30 px-3 py-2 rounded-lg font-sans">
                                <svg className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span><span className="font-semibold text-amber-400">Goal:</span> {call.reasoning}</span>
                              </div>
                            )}

                            {!call.ok && call.errorMessage && (
                              <div className="text-[10px] text-rose-400 font-sans border-t border-rose-950 pt-2 mt-1">
                                <span className="font-semibold">Error detail:</span> {call.errorMessage}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {steps.length === 0 && (
          <div className="text-center py-8 text-gray-600 italic text-sm">
            No steps have been recorded for this pipeline yet.
          </div>
        )}
      </div>
    </div>
  );
};
