FROM node:22-alpine

WORKDIR /app
RUN chown -R node:node /app

USER node

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js schema.sql ./

EXPOSE 3001
CMD ["npm", "start"]