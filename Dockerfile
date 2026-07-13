FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && mkdir -p /app/data \
    && chown -R pwuser:pwuser /app
COPY --chown=pwuser:pwuser --from=build /app/dist ./dist
COPY --chown=pwuser:pwuser server ./server
RUN command -v runuser >/dev/null \
    && chmod +x /app/server/docker-entrypoint.sh
EXPOSE 8787
ENTRYPOINT ["/app/server/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
