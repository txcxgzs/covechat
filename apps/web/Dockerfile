# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
COPY apps/web ./apps/web
COPY packages/protocol ./packages/protocol
RUN npm run build -w @covechat/web

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /src/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
