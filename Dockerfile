FROM node:22-slim

# Install system dependencies:
# - ffmpeg: video processing
# - canvas dependencies: libcairo2, libpango, libjpeg, libgif, librsvg2
# - build tools: python3, make, g++ (for native npm packages like canvas)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg is installed
RUN ffmpeg -version | head -1

# Install pnpm globally
RUN npm install -g pnpm@10

WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including native canvas)
RUN pnpm install --no-frozen-lockfile

# Copy all source files
COPY . .

# Build the TypeScript project
RUN pnpm run build

# Copy drizzle migrations to dist
RUN cp -r drizzle dist/drizzle

# Make start script executable
RUN chmod +x start.sh

# Railway injects PORT automatically; default to 3000 for local testing
ENV PORT=3000

# Use start.sh which handles FFmpeg path setup and starts the server
CMD ["sh", "start.sh"]
