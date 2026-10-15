# CrewSight relay only (no Electron)
FROM node:20-alpine
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY core ./core
COPY relay ./relay
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "relay/server.js"]
