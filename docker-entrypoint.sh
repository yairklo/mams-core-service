#!/bin/sh
set -e

echo "[entrypoint] Applying Prisma migrations..."
npx prisma migrate deploy

echo "[entrypoint] Starting MAMS core service..."
exec node dist/server.js
