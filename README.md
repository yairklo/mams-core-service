# MAMS Core Service

Standalone Multi-Agent Management System microservice, extracted from JoinUp.

## Quick start

```bash
cp .env.example .env
# Set MAMS_DATABASE_URL and ANTHROPIC_API_KEY

npm install
npm run db:push
npm run build
npm start
```

Service listens on **PORT=8080** by default.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/mams/task/start` | Accept a task from n8n (returns `202` + `taskId`) |
| `GET` | `/api/mams/task/:taskId` | Poll task status |
| `POST` | `/api/mams/webhook/cloud` | Vercel/Render deployment callback (TIER4) |

### Start task body

```json
{
  "objective": "Fix the login button hover state",
  "executionTier": "TIER2_STANDARD",
  "pmContext": {
    "initialRequest": { "source": "n8n" },
    "clarifyingQuestions": ["Which page?"],
    "developerReplies": ["Dashboard settings page"]
  }
}
```

## Execution tiers

| Tier | Graph |
|------|-------|
| `TIER1_FAST_TRACK` | PENDING → EXECUTING → DONE |
| `TIER2_STANDARD` | PENDING → EXECUTING → VERIFYING → DONE |
| `TIER3_CRITICAL` | PLANNING → SPEC_REVIEW → EXECUTING → VERIFYING → QA → DONE |
| `TIER4_ENTERPRISE_E2E` | Full chain + AWAITING_CLOUD_VERIFICATION → DONE |

## Security

- All sandboxes are confined to `./workspaces/` with `realpathSync` symlink resolution.
- Docker runs use `--user` (non-root) and `--network none`.
- SIGTERM/SIGINT triggers graceful child-process and container cleanup.
