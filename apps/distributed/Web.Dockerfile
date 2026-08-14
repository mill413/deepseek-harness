FROM node:24-bookworm-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.7.0

COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build:lib \
  && pnpm run build:web \
  && node apps/distributed/scripts/assemble-web.mjs /web-root

FROM nginx:1.29-alpine

COPY apps/distributed/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /web-root /usr/share/nginx/html

EXPOSE 80
