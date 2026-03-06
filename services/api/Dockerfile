FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY services/api/package.json services/api/package-lock.json* ./
RUN npm install --omit=dev

# Copy application files
COPY services/api/index.js ./index.js
COPY services/api/templates.js ./templates.js
COPY services/api/debug_tree.js ./debug_tree.js
COPY services/api/config.js ./config.js

# Copy modular directories (for future refactor)
COPY services/api/middleware ./middleware
COPY services/api/routes ./routes
COPY services/api/services ./services
COPY services/api/utils ./utils

# Copy shared database utilities
COPY services/shared ./shared

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "index.js"]
