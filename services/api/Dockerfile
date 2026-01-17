FROM node:20-alpine

WORKDIR /app

COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev

COPY api/index.js ./index.js
COPY shared ./shared

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "index.js"]
