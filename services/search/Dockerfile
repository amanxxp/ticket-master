# Build from the REPO ROOT, not this directory:
#   docker build -f services/search/Dockerfile -t tm-search .
FROM node:22-alpine

WORKDIR /app/services/search

# Manifest first, so editing code does not reinstall dependencies.
COPY services/search/package*.json ./
RUN npm install --omit=dev

COPY services/search/ ./

USER node
EXPOSE 3003

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in server.js would never run.
CMD ["node", "server.js"]
