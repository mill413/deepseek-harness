FROM node:24-bookworm-slim

WORKDIR /workspace
RUN npm install --global pnpm@11.7.0

COPY . .
RUN pnpm install --filter @deepseek-ai/dsh-distributed... --frozen-lockfile --ignore-scripts

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "apps/distributed/src/api.ts"]
