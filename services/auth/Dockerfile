# Build from the REPO ROOT, not this directory:
#   docker build -f services/auth/Dockerfile -t tm-auth .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder (middlewares/errorHandler.js, correlationId.js, roles.js).
FROM node:22-alpine

WORKDIR /app/services/auth

# Manifest first, so editing code does not reinstall dependencies.
COPY services/auth/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/auth/ ./

USER node
EXPOSE 3001

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in server.js would never run.
CMD ["node", "server.js"]
