# syntax=docker/dockerfile:1
# vless-voroa-in: VLESS over WebSocket on Voroa (Docker runtime).
# Dockerfile deployment is what makes a free Voroa service never idle-sleep
# (see https://getvoroa.com/docs/idle-sleep/).
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
# Zero dependencies: nothing to install.
EXPOSE 3000
# Voroa injects $PORT; server.js reads it (default 80 if unset).
CMD ["node", "server.js"]
