# ─────────────────────────────────────────────
#  dock-tools — Script Manager
#  Build:   docker build -t dock-tools .
#  Run:     docker run -d \
#             -p 3000:3000 \
#             -v /var/run/docker.sock:/var/run/docker.sock \
#             -v /opt/dock-tools/scripts-data:/app/scripts-data \
#             -e WEBHOOK_SECRET=your_secret \
#             -e HOST_SCRIPTS_DATA_PATH=/opt/dock-tools/scripts-data \
#             -e UI_PASSWORD=your_password \
#             --name dock-tools \
#             dock-tools
# ─────────────────────────────────────────────

FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y git ca-certificates --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY manager/package*.json ./
RUN npm install

COPY manager/tsconfig.json ./
COPY manager/src/ ./src/
RUN npm run build \
  && cp -r src/public dist/public \
  && npm prune --omit=dev

# ─────────────────────────────────────────────

FROM node:20-slim

RUN apt-get update && apt-get install -y git ca-certificates --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist        ./dist

# Non-sensitive runtime defaults
ENV NODE_ENV=production \
    PORT=3000 \
    UI_USERNAME=admin \
    HOST_SCRIPTS_DATA_PATH=/opt/dock-tools/scripts-data \
    DEFAULT_TIMEZONE=UTC \
    DOCKER_NETWORK=bridge
# Pass secrets at runtime: -e UI_PASSWORD=... -e WEBHOOK_SECRET=...

EXPOSE 3000

VOLUME ["/app/scripts-data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
