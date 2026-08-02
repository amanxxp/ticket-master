# Build from the REPO ROOT, not this directory:
#   docker build -f services/outbox-poller/Dockerfile -t tm-outbox-poller .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder.
FROM node:22-alpine

WORKDIR /app/services/outbox-poller

COPY services/outbox-poller/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/outbox-poller/ ./

USER node

# No EXPOSE — this process has no HTTP surface, per REQUIREMENTS.md's process
# table: "Outbox poller | — | worker, Postgres -> ES".

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in poller.js would never run.
CMD ["node", "poller.js"]
