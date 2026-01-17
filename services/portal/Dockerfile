FROM node:20-alpine

WORKDIR /app

COPY portal/package.json portal/package-lock.json* ./
RUN npm install --omit=dev

COPY portal/index.js ./index.js
COPY shared ./shared

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
