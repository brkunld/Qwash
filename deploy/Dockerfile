# syntax=docker/dockerfile:1
# QWASH production imaji: backend, musteri PWA'si ve admin paneli tek imajda derlenir;
# compose her servisi ayni imajdan farkli komutla calistirir (deploy/docker-compose.prod.yml).
# Next uygulamalari API adresini derleme aninda gomer (NEXT_PUBLIC_*): adres degisirse yeniden derle.

FROM node:24-bookworm-slim AS base
ENV CI=true NEXT_TELEMETRY_DISABLED=1
# openssl: Prisma schema engine (migration) icin gerekli
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@12.4.2
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

ARG CUSTOMER_API_URL
ARG ADMIN_API_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
RUN test -n "$CUSTOMER_API_URL" && test -n "$ADMIN_API_URL"

RUN pnpm --filter @qwash/contracts build \
  && pnpm --filter @qwash/backend build
RUN NEXT_PUBLIC_API_URL="$CUSTOMER_API_URL" NEXT_PUBLIC_GOOGLE_CLIENT_ID="$NEXT_PUBLIC_GOOGLE_CLIENT_ID" \
  pnpm --filter @qwash/web-customer build
RUN NEXT_PUBLIC_API_URL="$ADMIN_API_URL" NEXT_PUBLIC_GOOGLE_CLIENT_ID="$NEXT_PUBLIC_GOOGLE_CLIENT_ID" \
  pnpm --filter @qwash/web-admin build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
