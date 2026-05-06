FROM node:22-slim

# Install system dependencies:
# - ffmpeg: video processing
# - fonts-noto: NotoSans fonts (used by canvas for intro/outro cards)
# - canvas native deps: libcairo2, libpango, libjpeg, libgif, librsvg2
# - build tools: python3, make, g++ (for native npm packages like canvas)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-noto \
  fonts-noto-core \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -fv

# Verify FFmpeg is installed and working
RUN ffmpeg -version | head -1

# Verify fonts are installed
RUN fc-list | grep -i noto | head -5 || echo "WARNING: Noto fonts not found"

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

# Create uploads directory for local storage fallback
RUN mkdir -p /app/uploads

# Railway injects PORT automatically; default to 3000 for local testing
ENV PORT=3000

# Use start.sh which handles FFmpeg path setup and starts the server
CMD ["sh", "start.sh"]
