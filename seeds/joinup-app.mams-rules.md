# JoinUpApp — MAMS project rules (seed)

> Auto-seeded for agent workspaces when no substantive `.mams-rules.md` exists.

## Stack

- **Monorepo layout:** `server/` (Node/Express + Prisma + Socket.IO), `mobile_app/` (Expo/React Native), `next_app/` (Next.js web).
- **Database:** PostgreSQL via Prisma (`server/prisma/schema.prisma`).
- **Realtime:** Socket.IO in `server/index.js` — users join `user_<userId>` rooms for notifications.

## Notifications

- **Service:** `server/services/notificationService.js` — `sendNotification()`, push + DB + WebSocket `notification` event.
- **Routes:** `server/routes/notifications.js` mounted at `/api/notifications`.
- **Mobile hook:** `mobile_app/src/hooks/useNotification.ts` — FCM registration + in-app alerts.

## Messaging / chat

- Inspect `server/index.js` and routes for existing direct-message or chat endpoints before adding new ones.
- Prefer extending existing socket events and REST patterns over new parallel systems.

## Game join flow

- Join API: `POST /api/games/:id/join` (see `server/tests/gameRoster.test.js`).
- Hook server-side join handler to notify the **game owner** (not the joiner) via `NotificationService`.

## Commands (run from respective package dirs)

| Package | Lint/typecheck/test |
|---------|---------------------|
| `server/` | `npm test` (Jest), inspect `package.json` scripts |
| `mobile_app/` | `npx tsc --noEmit` if configured |
| `next_app/` | `npm run lint` if configured |

## i18n

- Mobile strings: `mobile_app/src/i18n/locales/he.json` and `en.json`.
- Add keys to **both** locales for every new UI string.

## Agent constraints

- Do not commit lockfile-only changes.
- Do not read `node_modules/` or `.git/`.
- Cross-stack features must touch **both** `server/` and `mobile_app/` when acceptance criteria span backend + UI.
- End CODER turns with `run_local_tests` on affected packages.
