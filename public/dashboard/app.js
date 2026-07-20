// Main Dashboard Application Orchestrator

const { useState, useEffect } = React;

function MamsDashboard() {
  const [tasks, setTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskDetail, setTaskDetail] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Task creation form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [submittingForm, setSubmittingForm] = useState(false);

  const fetchTaskList = async () => {
    try {
      setErrorMsg(null);
      const res = await fetch(window.location.origin + "/api/mams/tasks");
      if (!res.ok) throw new Error("Failed to fetch task list");
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err) {
      console.error(err);
      setErrorMsg("MAMS Backend unavailable or CORS error.");
    } finally {
      setLoadingList(false);
    }
  };

  const fetchTaskDetail = async (id) => {
    if (!id) return;
    try {
      const res = await fetch(window.location.origin + "/api/mams/task/" + id);
      if (!res.ok) throw new Error("Failed to fetch task detail");
      const data = await res.json();
      setTaskDetail(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchTaskList();
    const interval = setInterval(fetchTaskList, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      return;
    }
    setLoadingDetail(true);
    fetchTaskDetail(selectedTaskId).finally(() => setLoadingDetail(false));

    const interval = setInterval(() => {
      fetchTaskDetail(selectedTaskId);
    }, 3000);

    return () => clearInterval(interval);
  }, [selectedTaskId]);

  const handleAbort = async () => {
    if (!selectedTaskId) return;
    if (!confirm("Are you sure you want to abort this task?")) return;
    try {
      const res = await fetch(window.location.origin + "/api/mams/task/" + selectedTaskId + "/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "human", reason: "Aborted from dashboard console" })
      });
      if (!res.ok) throw new Error("Failed to abort task");
      fetchTaskDetail(selectedTaskId);
      fetchTaskList();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleResume = async (guidanceText) => {
    if (!selectedTaskId) return;
    try {
      const res = await fetch(window.location.origin + "/api/mams/task/" + selectedTaskId + "/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userGuidance: guidanceText })
      });
      if (!res.ok) throw new Error("Failed to resume task");
      fetchTaskDetail(selectedTaskId);
      fetchTaskList();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateSubmit = async (formData) => {
    setSubmittingForm(true);

    const criteria = formData.criteriaText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const deadlineMs = Math.round(Number(formData.deadlineHours || 1) * 3600 * 1000);

    const body = {
      objective: formData.objective,
      executionTier: formData.executionTier,
      acceptanceCriteria: criteria,
      deadlineMs: isNaN(deadlineMs) || deadlineMs <= 0 ? 3600000 : deadlineMs,
    };

    if (formData.preferredProvider !== "AUTO") {
      body.preferredProvider = formData.preferredProvider;
    }
    if (formData.modelOverride.trim()) {
      body.modelOverride = formData.modelOverride.trim();
    }

    try {
      const res = await fetch(window.location.origin + "/api/mams/task/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Failed to launch pipeline");
      }

      const data = await res.json();
      const newTaskId = data.taskId;

      setShowCreateModal(false);
      await fetchTaskList();
      setSelectedTaskId(newTaskId);
    } catch (err) {
      alert("Error starting task: " + err.message);
    } finally {
      setSubmittingForm(false);
    }
  };

  const isTerminalStatus = (status) => {
    return ["DONE", "FAILED", "ABORTED_FUSE", "CANCELLED", "ABORTED"].includes(status);
  };

  // Compute metrics
  const steps = taskDetail?.steps || [];
  const totalCost = steps.reduce((sum, s) => sum + (s.usage?.estimatedCostUsd || 0), 0);
  const totalInputTokens = steps.reduce((sum, s) => sum + (s.usage?.inputTokens || 0), 0);
  const totalOutputTokens = steps.reduce((sum, s) => sum + (s.usage?.outputTokens || 0), 0);

  const costByRole = {};
  steps.forEach((s) => {
    const role = s.role || "UNKNOWN";
    costByRole[role] = (costByRole[role] || 0) + (s.usage?.estimatedCostUsd || 0);
  });

  const getStatusColor = (status) => {
    switch (status) {
      case "DONE": return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "FAILED":
      case "ABORTED_FUSE": return "bg-rose-500/10 text-rose-400 border-rose-500/20";
      case "ESCALATED": return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      default: return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    }
  };

  const getRoleColor = (role) => {
    switch (role) {
      case "ARCHITECT": return "bg-purple-500/20 text-purple-300 border-purple-500/30";
      case "CODER": return "bg-sky-500/20 text-sky-300 border-sky-500/30";
      case "TESTER": return "bg-indigo-500/20 text-indigo-300 border-indigo-500/30";
      case "QA": return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
      case "SPEC_REVIEWER": return "bg-pink-500/20 text-pink-300 border-pink-500/30";
      case "SUPERVISOR": return "bg-amber-500/20 text-amber-300 border-amber-500/30";
      default: return "bg-gray-500/20 text-gray-300 border-gray-500/30";
    }
  };

  return (
    <div className="flex-1 bg-gray-950 text-gray-100 min-h-screen p-6 md:p-12">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-800 pb-5">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-2">
              <window.ActivityIcon />
              MAMS Control Center
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Real-time multi-agent pipeline monitoring, budget tracking, and human-in-the-loop console.
            </p>
          </div>

          {/* Task Selector */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-400 flex items-center gap-1">
              <window.TerminalIcon /> Monitor Task:
            </span>
            <select
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[280px] max-w-sm"
            >
              <option value="">-- Choose an active/past pipeline --</option>
              {tasks.map((task) => (
                <option key={task.taskId} value={task.taskId}>
                  {"[" + task.status + "] " + task.taskId.slice(0, 8) + "... (" + task.executionTier + ")"}
                </option>
              ))}
            </select>
            <button
              onClick={fetchTaskList}
              className="p-2 bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg transition"
              title="Refresh Task List"
            >
              <window.RefreshCwIcon className={loadingList ? "animate-spin" : ""} />
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition flex items-center gap-1.5 shadow"
            >
              <window.PlusIcon /> Launch Pipeline
            </button>
          </div>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-red-950/20 border border-red-900/50 rounded-xl p-4 flex items-start gap-3">
            <window.AlertTriangleIcon />
            <div>
              <h4 className="font-semibold text-red-400">Connection Error</h4>
              <p className="text-sm text-gray-300 mt-0.5">{errorMsg}</p>
            </div>
          </div>
        )}

        {/* Default State */}
        {!selectedTaskId && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-12 text-center flex flex-col items-center justify-center">
            <window.TerminalIcon />
            <h3 className="text-xl font-semibold text-gray-300 mt-3">No Task Selected</h3>
            <p className="text-sm text-gray-500 max-w-md mt-2">
              Select an active agent pipeline from the dropdown to view metrics, timeline actions, and controls, or launch a new task.
            </p>
          </div>
        )}

        {/* Selected Task Details */}
        {selectedTaskId && taskDetail && (
          <>
            {/* Metrics Cards */}
            <window.MetricCards
              totalCost={totalCost}
              totalInputTokens={totalInputTokens}
              totalOutputTokens={totalOutputTokens}
              costByRole={costByRole}
            />

            {/* Task Contract & Blueprint */}
            <window.ContractBlueprint taskDetail={taskDetail} />

            {/* Dashboard grid panel */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Metadata Sidebar */}
              <window.MetadataSidebar
                taskDetail={taskDetail}
                getStatusColor={getStatusColor}
              />

              {/* HITL Control Panel */}
              <div className="lg:col-span-2">
                <window.HitlConsole
                  taskDetail={taskDetail}
                  isTerminalStatus={isTerminalStatus}
                  onAbort={handleAbort}
                  onResume={handleResume}
                />
              </div>
            </div>

            {/* Live Steps Feed Timeline */}
            <window.Timeline
              steps={steps}
              getRoleColor={getRoleColor}
            />
          </>
        )}

        {/* Create Task Modal */}
        {showCreateModal && (
          <window.CreateTaskModal
            onClose={() => setShowCreateModal(false)}
            onSubmit={handleCreateSubmit}
            submitting={submittingForm}
          />
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<MamsDashboard />);
