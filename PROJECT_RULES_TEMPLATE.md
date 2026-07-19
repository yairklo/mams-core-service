# MAMS Project Rules Template

Copy this file into your **target application repository** (the codebase MAMS
clones into its task workspace) and rename it to:

```
.mams-rules.md
```

MAMS agents load global behavioral personas from the microservice. **This file
is the only place** to define project-specific stack, schema, security, and CI
expectations for that codebase.

Delete the HTML comment blocks as you fill each section. Keep headings so agents
can scan constraints quickly.

---

## 1. Tech Stack Conventions

<!-- Example: monorepo layout, primary languages, framework versions -->

### Runtime & frameworks

- **Primary stack:** <!-- e.g. Node 20, TypeScript 5.x, Express 4.x -->
- **Frontend:** <!-- e.g. React Native / Expo, or Next.js App Router — or N/A -->
- **Backend:** <!-- e.g. REST on `/api/*`, or GraphQL — or N/A -->
- **Package manager:** <!-- npm | pnpm | yarn — include lockfile policy -->

### Directory layout

- **Application entry:** <!-- e.g. `src/server.ts`, `app/layout.tsx` -->
- **Shared types:** <!-- e.g. `src/types/` -->
- **API routes:** <!-- e.g. `src/routes/` or `app/api/` -->
- **Tests:** <!-- e.g. `**/*.test.ts` colocated vs `tests/` mirror -->
- **Do not touch:** <!-- e.g. generated `dist/`, `node_modules/`, vendor dirs -->

### Coding standards

- **Lint / format:** <!-- e.g. ESLint + Prettier — commands to run -->
- **Type checking:** <!-- e.g. `npm run build` or `tsc --noEmit` -->
- **Import style:** <!-- e.g. path aliases `@/`, no default exports for utils -->
- **Error handling:** <!-- e.g. never swallow errors; use typed Result patterns -->

---

## 2. Core Database Relationships

<!-- Example: ORM, schema location, migration policy, key entities -->

### Data layer

- **ORM / client:** <!-- e.g. Prisma, Drizzle, raw SQL -->
- **Schema location:** <!-- e.g. `prisma/schema.prisma` -->
- **Migration command:** <!-- e.g. `npx prisma migrate dev` — prod restrictions -->
- **Connection env var:** <!-- e.g. `DATABASE_URL` — never commit secrets -->

### Entity map (high level)

<!-- List the 5–10 entities agents most often touch and how they relate -->

| Entity | Table / model | Key relationships | Notes |
|--------|---------------|-------------------|-------|
| <!-- User --> | <!-- users --> | <!-- has many X --> | <!-- soft-delete? --> |
| <!-- ... --> | | | |

### Invariants agents must preserve

- <!-- e.g. All user-scoped queries MUST filter by `userId` -->
- <!-- e.g. Never drop columns without a migration + backfill plan -->
- <!-- e.g. Foreign keys: ON DELETE behavior is CASCADE vs RESTRICT — document here -->

---

## 3. Security & Authentication Constraints

<!-- Example: auth provider, session model, secrets handling -->

### Authentication

- **Mechanism:** <!-- JWT | session cookie | OAuth provider | API keys -->
- **Protected routes:** <!-- how middleware applies; public allowlist -->
- **Test accounts:** <!-- how to obtain / mock auth in local tests -->

### Authorization

- **Role model:** <!-- roles, permissions matrix summary -->
- **Tenant isolation:** <!-- multi-tenant rules if applicable -->

### Secrets & sensitive data

- **Never log:** <!-- tokens, passwords, PII fields -->
- **Env files:** <!-- `.env.local` pattern; which vars are required locally -->
- **PII / compliance:** <!-- GDPR, retention, encryption at rest requirements -->

### Dependency & supply chain

- **Approved packages:** <!-- optional allowlist or "no new deps without review" -->
- **CVE policy:** <!-- e.g. no critical vulns in `npm audit` -->

---

## 4. CI/CD Expectations

<!-- Example: required checks before merge, deploy hooks -->

### Required local checks (run before claiming done)

```bash
# Replace with your project's canonical verification commands
npm run lint
npm run test
npm run build
```

### Continuous integration

- **CI platform:** <!-- GitHub Actions | GitLab CI | etc. -->
- **Required status checks:** <!-- job names that must pass on PR -->
- **Branch policy:** <!-- main protected; feature branch naming -->

### Deployment & environments

- **Environments:** <!-- dev | staging | prod URLs or identifiers -->
- **Deploy trigger:** <!-- merge to main | manual workflow -->
- **Post-deploy verification:** <!-- smoke tests, health endpoints -->
- **Rollback:** <!-- how to revert a bad deploy -->

### MAMS-specific notes

- **Sandbox commands:** Agents use `run_local_tests` — prefer the commands
  listed above so local and CI stay aligned.
- **Git identity in workspace:** MAMS sets `user.name` / `user.email` for agent
  commits; follow your project's commit message convention here:
  <!-- e.g. Conventional Commits: feat(scope): description -->

---

## 5. Optional: Domain Glossary

<!-- Reduce ambiguity for agents working on product-specific language -->

| Term | Meaning | Related code / modules |
|------|---------|------------------------|
| <!-- ... --> | | |

---

## 6. Optional: Out of Scope

<!-- Explicitly tell agents what NOT to refactor in this repo -->

- <!-- e.g. Do not modify mobile release pipelines -->
- <!-- e.g. Do not change payment provider integration without human approval -->
