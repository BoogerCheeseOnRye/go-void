FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY public ./public

USER node
EXPOSE 4173

CMD ["node", "server/server.mjs"]
