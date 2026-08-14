FROM node:24-bookworm-slim

WORKDIR /workspace
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.7.0

COPY . .
ENV npm_config_nodedir=/usr/local
RUN pnpm install --filter @deepseek-ai/dsh-distributed... --frozen-lockfile

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "apps/distributed/src/workspace-service.ts"]
