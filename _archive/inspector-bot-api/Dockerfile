FROM node:20-bookworm-slim

# Install minimal system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source code
COPY config/ ./config/
COPY src/ ./src/

# Create temp directories
RUN mkdir -p /tmp/uploads

EXPOSE 3000

CMD ["node", "src/server.js"]
