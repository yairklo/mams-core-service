-- Persisted agent step records for /task/:id/steps observability
CREATE TABLE "mams"."AgentStepRecord" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "narrativeSummary" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "usage" JSONB NOT NULL,
    "timestampMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStepRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentStepRecord_taskId_stepId_key" ON "mams"."AgentStepRecord"("taskId", "stepId");
CREATE INDEX "AgentStepRecord_taskId_stepIndex_idx" ON "mams"."AgentStepRecord"("taskId", "stepIndex");
