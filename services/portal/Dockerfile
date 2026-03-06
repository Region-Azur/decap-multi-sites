FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY services/portal/package.json services/portal/package-lock.json* ./
RUN npm install --omit=dev

# Copy application files
COPY services/portal/index.js ./index.js
COPY services/portal/config.js ./config.js

# Copy modular directories
COPY services/portal/middleware ./middleware
COPY services/portal/views ./views
COPY services/portal/utils ./utils
COPY services/portal/public ./public

# Copy static assets (favicons, logos, etc.) from root static-assets folder
COPY static-assets/favicon/ ./public/
COPY static-assets/*.svg ./public/

# Copy shared database utilities
COPY services/shared ./shared
# Keep compatibility for imports like ../../shared/* from /app/views/*
COPY services/shared /shared

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
