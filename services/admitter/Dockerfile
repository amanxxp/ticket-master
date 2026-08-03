# Build from the REPO ROOT, not this directory:
#   docker build -f services/admitter/Dockerfile -t tm-admitter .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder.
FROM node:22-alpine

WORKDIR /app/services/admitter

COPY services/admitter/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/admitter/ ./

USER node

# No EXPOSE — this process has no HTTP surface, per REQUIREMENTS.md's process
# table: a worker, not a service.

# Direct node, no npm wrapper: npm would swallow SIGTERM, and releasing the
# leader lease on shutdown depends on that signal actually reaching the process.
CMD ["node", "admitter.js"]
