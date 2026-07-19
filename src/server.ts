/**
 * Standalone MAMS microservice entrypoint.
 */

import express from "express";
import { disconnectDatabase } from "./database.js";
import { loadMamsEnv } from "./env.js";
import { warmGoogleModelResolverCache } from "./googleModelResolver.js";
import { PrismaFiscalBudgetLedger, StateMachine } from "./fsmEngine.js";
import { gracefulProcessShutdown } from "./processRegistry.js";
import { mountMamsRoutes } from "./router.js";

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal} — shutting down gracefully...`);

  try {
    await gracefulProcessShutdown();
    await disconnectDatabase();
    console.log("[server] Cleanup complete.");
  } catch (err) {
    console.error("[server] Error during shutdown:", err);
  } finally {
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const env = loadMamsEnv();

  void warmGoogleModelResolverCache().catch((err) => {
    console.warn("[server] Google model resolver warm-up failed (non-fatal):", err);
  });

  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "mams-core-service" });
  });

  const stateMachine = new StateMachine({
    fiscalBudgetLedger: new PrismaFiscalBudgetLedger(env.MAMS_FISCAL_BUDGET_LIMIT_USD),
  });

  mountMamsRoutes(app, {
    stateMachine,
    defaultDeadlineMs: env.MAMS_DEFAULT_DEADLINE_MS,
    fiscalBudgetLimitUsd: env.MAMS_FISCAL_BUDGET_LIMIT_USD,
  });

  const server = app.listen(env.PORT, () => {
    console.log(`[server] MAMS core service listening on port ${env.PORT}`);
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      void shutdown("SIGTERM");
    });
  });

  process.on("SIGINT", () => {
    server.close(() => {
      void shutdown("SIGINT");
    });
  });
}

void main();
