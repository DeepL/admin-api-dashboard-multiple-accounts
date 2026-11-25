# Multi-account usage dashboard. No npm dependencies, so there is nothing to install.
FROM node:24-alpine

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production

# Run as a non-root user, as Kubernetes platforms typically require. The server
# only reads its files, so they can stay root-owned.
USER 1001:1001

EXPOSE 3000

# Configure with environment variables (see README, "Docker"). Without a
# config file the container needs DEEPL_DASHBOARD_SAMPLE=1 or a mounted config.
CMD ["node", "server.js"]
