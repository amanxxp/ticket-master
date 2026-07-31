# Build from the REPO ROOT, not this directory:
#   docker build -f services/booking/Dockerfile -t tm-booking .
# Root context is required: this service imports ../../../shared/, which is
# outside its own folder.
FROM node:22-alpine

WORKDIR /app/services/booking

# Manifest first, so editing code does not reinstall dependencies.
COPY services/booking/package*.json ./
RUN npm install --omit=dev

COPY shared/ /app/shared/

COPY services/booking/ ./

USER node
EXPOSE 3004

# Direct node, no npm wrapper: npm would swallow SIGTERM and the graceful
# shutdown in server.js would never run.
CMD ["node", "server.js"]
