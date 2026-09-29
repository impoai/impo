# Build context is the repo root (npm workspace root + server/).
# Runs the same way as `npm run dev:api`/`dev:worker`, just without --env-file
# (the container gets its environment from the ECS task definition instead).
FROM node:22-bookworm-slim
# Temporal native gRPC uses the OS trust store (Node fetch has bundled roots).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci
COPY server server
WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/api-main.ts"]
