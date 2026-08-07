# ─── Builder stage ──────────────────────────────────────────────────────────
# Compiles TypeScript, builds the client bundle, and installs native modules
# (needs the -dev headers + build toolchain below). Nothing from this stage
# ships in the final image except the build output and pruned node_modules.
FROM node:22-slim AS builder

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
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile

# Copy all source files
COPY . .

# Build the TypeScript project (vite client build + esbuild server bundles)
RUN pnpm run build

# Copy drizzle migrations to dist
RUN cp -r drizzle dist/drizzle

# Drop devDependencies (TypeScript, Vite, Vitest, esbuild, ...) — the built
# dist/ output no longer needs them, only whatever the bundled server code
# imports at runtime (kept via --packages=external in the build script).
RUN pnpm prune --prod

# ─── Runtime stage ───────────────────────────────────────────────────────────
# Only what's needed to run the already-built app: no TypeScript source, no
# build toolchain, no devDependencies — meaningfully smaller than shipping
# the full builder stage. Keeps the same (already-proven-working) apt package
# set as the builder rather than switching to slimmer runtime-only library
# variants — this can't be build-tested in this environment (no Docker
# daemon available in the sandbox), so known-good package names win over a
# smaller but unverified image.
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-noto \
  fonts-noto-core \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -fv

# Verify FFmpeg is installed and working
RUN ffmpeg -version | head -1

# Verify fonts are installed
RUN fc-list | grep -i noto | head -5 || echo "WARNING: Noto fonts not found"

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./package.json
COPY start.sh worker-start.sh ./

RUN chmod +x start.sh worker-start.sh

# Create uploads directory for local storage fallback
RUN mkdir -p /app/uploads

# Run as a non-root user — this process shells out to FFmpeg/native image libraries against
# untrusted media (curated archive uploads, downloaded stock/archive footage); a vulnerability
# in any of those decoders shouldn't hand over root inside the container.
RUN groupadd -r app && useradd -r -g app -d /app app \
  && chown -R app:app /app
USER app

# Railway injects PORT automatically; default to 3000 for local testing
ENV PORT=3000

# Use start.sh which handles FFmpeg path setup and starts the server
CMD ["sh", "start.sh"]
