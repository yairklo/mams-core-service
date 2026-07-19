# =============================================================================
# MAMS Core Service — production image with Claude Code CLI support
# =============================================================================

# --- Stage 1: build TypeScript + Prisma client --------------------------------
FROM node:20-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts/
COPY prompts ./prompts/
COPY src ./src/

RUN npm run build \
  && npm prune --omit=dev

# --- Stage 2: lean runtime ----------------------------------------------------
FROM node:20-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_PREFIX=/home/mams/.npm-global \
    PATH=/home/mams/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

RUN groupadd --system --gid 1001 mams \
  && useradd --system --uid 1001 --gid mams --create-home --home-dir /home/mams mams \
  && mkdir -p /app/workspaces /home/mams/.claude /home/mams/.npm-global \
  && chown -R mams:mams /app /home/mams

WORKDIR /app

USER mams

# Official Anthropic Claude Code CLI — used by execute_claude_code_escalation / `claude -p`
RUN npm install -g @anthropic-ai/claude-code@latest

COPY --from=builder --chown=mams:mams /app/dist ./dist
COPY --from=builder --chown=mams:mams /app/node_modules ./node_modules
COPY --from=builder --chown=mams:mams /app/package.json ./package.json
COPY --from=builder --chown=mams:mams /app/prisma ./prisma
COPY --chown=mams:mams docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
