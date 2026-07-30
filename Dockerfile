FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48
ARG BUILD_DATE=unknown
ARG VCS_REF=unknown
ARG VERSION=dev
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
LABEL org.opencontainers.image.title="Frosted Console" \
      org.opencontainers.image.description="Self-hosted upstream balance monitoring console with a headed Chromium workspace" \
      org.opencontainers.image.source="https://github.com/YUYUEYUER/zzzjiankong" \
      org.opencontainers.image.url="https://github.com/YUYUEYUER/zzzjiankong" \
      org.opencontainers.image.documentation="https://github.com/YUYUEYUER/zzzjiankong#readme" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}"
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      novnc \
      openbox \
      websockify \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && mkdir -p /app/data \
    && chown -R pwuser:pwuser /app/data \
    && chmod -R a=rX /app/node_modules
COPY --chown=root:root --from=build /app/dist ./dist
COPY --chown=root:root server ./server
RUN command -v runuser >/dev/null \
    && chmod -R a=rX /app/dist /app/server \
    && chmod +x /app/server/docker-entrypoint.sh
EXPOSE 8787 6080
ENTRYPOINT ["/app/server/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
