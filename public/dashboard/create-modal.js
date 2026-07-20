// CreateTaskModal React Component

const { useState } = React;

window.CreateTaskModal = ({ onClose, onSubmit, submitting }) => {
  const [newObjective, setNewObjective] = useState("");
  const [newExecutionTier, setNewExecutionTier] = useState("TIER2_STANDARD");
  const [newCriteriaText, setNewCriteriaText] = useState("");
  const [newPreferredProvider, setNewPreferredProvider] = useState("AUTO");
  const [newModelOverride, setNewModelOverride] = useState("");
  const [newDeadlineHours, setNewDeadlineHours] = useState("1");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newObjective.trim()) return;

    onSubmit({
      objective: newObjective.trim(),
      executionTier: newExecutionTier,
      criteriaText: newCriteriaText,
      preferredProvider: newPreferredProvider,
      modelOverride: newModelOverride,
      deadlineHours: newDeadlineHours
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <window.PlayIcon />
            Launch New Agent Pipeline
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition"
          >
            <window.XIcon />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block font-sans">
              Task Objective *
            </label>
            <textarea
              required
              value={newObjective}
              onChange={(e) => setNewObjective(e.target.value)}
              placeholder="Describe exactly what the developer agent should do..."
              className="w-full bg-gray-950 border border-gray-800 rounded-lg p-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[100px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
                Execution Tier
              </label>
              <select
                value={newExecutionTier}
                onChange={(e) => setNewExecutionTier(e.target.value)}
                className="w-full bg-gray-955 border border-gray-800 rounded-lg p-2.5 text-sm text-gray-250 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="TIER1_FAST_TRACK">Tier 1: Fast Track (Single Coder turn)</option>
                <option value="TIER2_STANDARD">Tier 2: Standard (Planning + Coder)</option>
                <option value="TIER3_CRITICAL">Tier 3: Critical (Architect + Planning + E2E)</option>
                <option value="TIER4_ENTERPRISE_E2E">Tier 4: Enterprise E2E (Full hardening)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
                Deadline (Hours)
              </label>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={newDeadlineHours}
                onChange={(e) => setNewDeadlineHours(e.target.value)}
                className="w-full bg-gray-955 border border-gray-850 rounded-lg p-2.5 text-sm text-gray-250 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
              Acceptance Criteria (one per line)
            </label>
            <textarea
              value={newCriteriaText}
              onChange={(e) => setNewCriteriaText(e.target.value)}
              placeholder="e.g.&#10;Verify user rating persists on Neon&#10;No compile errors in next_app lint"
              className="w-full bg-gray-955 border border-gray-850 rounded-lg p-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[80px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-800 pt-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
                Preferred Provider
              </label>
              <select
                value={newPreferredProvider}
                onChange={(e) => setNewPreferredProvider(e.target.value)}
                className="w-full bg-gray-955 border border-gray-800 rounded-lg p-2.5 text-sm text-gray-255 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="AUTO">Auto (Balanced routing)</option>
                <option value="GOOGLE">Google Generative AI (Flash/Pro)</option>
                <option value="ANTHROPIC">Anthropic (Claude Sonnet 3.5)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
                Model Override (Optional)
              </label>
              <input
                type="text"
                value={newModelOverride}
                onChange={(e) => setNewModelOverride(e.target.value)}
                placeholder="e.g. claude-3-5-sonnet-latest"
                className="w-full bg-gray-955 border border-gray-850 rounded-lg p-2.5 text-sm text-gray-205 placeholder-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-gray-800 pt-4 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-semibold transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold transition flex items-center gap-1.5 shadow"
            >
              {submitting ? (
                <span className="flex items-center gap-1.5">
                  <window.RefreshCwIcon className="animate-spin" /> Launching...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <window.PlayIcon /> Launch Pipeline
                </span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
