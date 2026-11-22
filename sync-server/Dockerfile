# docker build -t feishin-sync sync-server
FROM node:22-alpine
WORKDIR /app

# Match packageManager in the root package.json
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

# Installed standalone: a filtered workspace install would also pull in the app's
# dependencies. ws is pinned exactly and has no dependencies of its own.
COPY package.json ./
RUN pnpm install --prod --ignore-workspace

COPY server.mjs broker.mjs ./

ENV NODE_ENV=production PORT=4534
EXPOSE 4534
USER node
CMD ["node", "server.mjs"]
