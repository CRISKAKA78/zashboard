# Static UI only. Local Helper remains a separate host service.
FROM docker.io/library/node:22.18.0-alpine AS builder

WORKDIR /build

COPY . .

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build:no-fonts

FROM docker.io/caddy:alpine

EXPOSE 80

WORKDIR /srv

COPY --from=builder /build/dist/. .
COPY Caddyfile .

CMD ["caddy", "run"]
