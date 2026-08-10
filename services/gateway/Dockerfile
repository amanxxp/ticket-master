# Build from the REPO ROOT, not this directory:
#   docker build -f services/gateway/Dockerfile -t tm-gateway .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder (middlewares/errorHandler.js, policy.js, correlationId.js).
FROM node:22-alpine

WORKDIR /app/services/gateway

# Manifest first, so editing code does not reinstall dependencies.
COPY services/gateway/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/gateway/ ./

USER node
EXPOSE 3000

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in server.js would never run.
CMD ["node", "server.js"]
