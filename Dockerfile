FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY scripts/silence-signal-logs.mjs ./scripts/silence-signal-logs.mjs
RUN npm ci
COPY . .
RUN npm run build:crm

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package*.json ./
COPY scripts/silence-signal-logs.mjs ./scripts/silence-signal-logs.mjs
RUN npm ci --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps chromium && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /opt/playwright
COPY --from=builder /app/build ./build
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config/supabase-prod-ca.crt ./config/supabase-prod-ca.crt
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Run additive, checksum-verified migrations even when the hosting provider ignores
# legacy railway.json configuration. exec preserves graceful signal handling.
CMD ["sh", "-c", "node build/scripts/migrate.js && exec node build/server/index.js"]
