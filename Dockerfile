# Build from systems/: docker build -f nb-search-cloud/Dockerfile -t nb-search-cloud:local .
FROM node:24.18.0-bookworm-slim AS toolchain
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build

FROM toolchain AS sdk-build
WORKDIR /build/nb-search
COPY nb-search/ ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM toolchain AS cloud-build
WORKDIR /build/nb-search-cloud
COPY --from=sdk-build /build/nb-search /build/nb-search
COPY nb-search-cloud/package.json nb-search-cloud/pnpm-lock.yaml nb-search-cloud/tsconfig.json ./
COPY nb-search-cloud/src ./src
RUN pnpm install --frozen-lockfile && pnpm build

FROM toolchain AS web-build
WORKDIR /build/nb-search-cloud/web
COPY nb-search-cloud/web/ ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM toolchain AS production-dependencies
WORKDIR /build/nb-search-cloud
COPY --from=sdk-build /build/nb-search/package.json /build/nb-search/package.json
COPY --from=sdk-build /build/nb-search/dist /build/nb-search/dist
COPY nb-search-cloud/package.json nb-search-cloud/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 CLOUD_EXECUTION_HOME=/var/lib/nbcloud/execution
WORKDIR /app/nb-search-cloud
COPY --from=production-dependencies /build/nb-search-cloud/package.json ./package.json
COPY --from=production-dependencies /build/nb-search-cloud/node_modules ./node_modules
COPY --from=production-dependencies /build/nb-search /app/nb-search
COPY --from=cloud-build /build/nb-search-cloud/dist ./dist
COPY nb-search-cloud/migrations ./migrations
COPY --from=web-build /build/nb-search-cloud/web/dist ./web/dist
RUN groupadd --system --gid 10001 nbcloud && useradd --system --uid 10001 --gid 10001 --create-home nbcloud \
    && mkdir -p /var/lib/nbcloud/execution && chown -R 10001:10001 /var/lib/nbcloud
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
