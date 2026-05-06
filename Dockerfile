FROM oven/bun:1.3.5

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway-fastify/package.json packages/gateway-fastify/package.json
COPY packages/gateway-web/package.json packages/gateway-web/package.json
COPY packages/analysis/package.json packages/analysis/package.json

RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "run", "./packages/gateway-fastify/src/start-fly.ts"]
