# Build from the REPO ROOT, not this directory:
#   docker build -f services/reconciler/Dockerfile -t tm-reconciler .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder.
FROM node:22-alpine

WORKDIR /app/services/reconciler

# Manifest first, so editing code does not reinstall dependencies.
COPY services/reconciler/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/reconciler/ ./

USER node

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in server.js would never run.
CMD ["node", "reconciler.js"]
