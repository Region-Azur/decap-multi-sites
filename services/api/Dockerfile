FROM node:20-slim

# Build tools + libvips-dev: needed only when sharp must compile from source
# (e.g., the prebuilt binary download fails or the CPU lacks the required ISA level).
# They add ~40 MB but keep the image self-contained.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY services/api/package.json services/api/package-lock.json* ./
# --include=optional ensures sharp's prebuilt binary (node-pre-gyp) is fetched.
# If the prebuilt binary is unavailable for this CPU, npm will compile from source
# using the libvips-dev installed above.
RUN npm install --omit=dev --include=optional

# Copy application files
COPY services/api/server.js ./server.js
COPY services/api/index.js ./index.js
COPY services/api/templates.js ./templates.js
COPY services/api/config.js ./config.js
COPY services/api/db.js ./db.js

# Copy modular directories
COPY services/api/lib ./lib
COPY services/api/routes ./routes
COPY services/api/middleware ./middleware
COPY services/api/services ./services
COPY services/api/utils ./utils

# Copy shared database utilities
COPY services/shared ./shared

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "server.js"]
