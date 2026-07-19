-- MAMS standalone schema initial migration
CREATE TABLE "AgentTaskState" (
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTaskState_pkey" PRIMARY KEY ("taskId")
);

CREATE TABLE "AgentCostLedger" (
    "costScopeId" TEXT NOT NULL,
    "spentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCostLedger_pkey" PRIMARY KEY ("costScopeId")
);

CREATE TABLE "AgentExecutionLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExecutionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTaskState_sessionId_idx" ON "AgentTaskState"("sessionId");
CREATE INDEX "AgentTaskState_status_idx" ON "AgentTaskState"("status");
CREATE INDEX "AgentTaskState_parentTaskId_idx" ON "AgentTaskState"("parentTaskId");
CREATE INDEX "AgentExecutionLog_taskId_idx" ON "AgentExecutionLog"("taskId");
CREATE INDEX "AgentExecutionLog_createdAt_idx" ON "AgentExecutionLog"("createdAt");
