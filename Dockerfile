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
  gosu \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -fv

# Verify FFmpeg is installed and working
RUN ffmpeg -version | head -1

# Verify fonts are installed
RUN fc-list | grep -i noto | head -5 || echo "WARNING: Noto fonts not found"

# ─── chrome-headless-shell, for Remotion ─────────────────────────────────────
# Without this binary every graphic is silently absent. Render 569 shipped with
#   [Preflight] NO chrome_headless_shell — absent, the render falls back to
#               libass, and graphics are not drawn
# and three [SceneCritical] overlay "HITLER" not planned lines: the director
# planned a name overlay on three scenes and there was nothing to draw it with.
#
# It has to be chrome-headless-shell and NOT full Chrome or Chromium. Remotion
# needs the OLD headless mode, which the full binary no longer provides — that
# is measured, not assumed; see the doc comment in server/remotionRenderer.ts.
#
# The symlink lands on /usr/bin/chrome-headless-shell, which is already the
# third path resolveRemotionBrowser() looks at, so no environment variable is
# needed. A deployment that keeps its browser elsewhere can still point
# REMOTION_BROWSER_EXECUTABLE at it and win — that path is checked first.
RUN apt-get update && apt-get install -y \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libatspi2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  `# @puppeteer/browsers ships the shell as a .zip and shells out to unzip to extract it.` \
  `# node:22-slim has no archiver at all, so the download succeeded and the extraction did not:` \
  `#   Extraction failed: no zip archiver is available. Install 'unzip' ...` \
  unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable \
      --path /opt/browsers \
  && ln -sf "$(find /opt/browsers -name chrome-headless-shell -type f | head -1)" \
      /usr/bin/chrome-headless-shell

# Fail the BUILD rather than the render, and SAY WHY.
#
# Without this check a missing library ships happily and every render quietly
# loses its graphics instead — exactly how this went unnoticed until a
# production log was read line by line. And `exit code: 1` on its own costs a
# whole deploy cycle to diagnose, so `ldd` names the missing library in the
# build log itself: the difference between one more push and three.
RUN /usr/bin/chrome-headless-shell --version \
  || { echo "=== chrome-headless-shell will not start. Missing shared libraries: ==="; \
       ldd /usr/bin/chrome-headless-shell | grep "not found" || echo "(none — see the error above)"; \
       exit 1; }

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./package.json
COPY start.sh worker-start.sh ./

RUN chmod +x start.sh worker-start.sh

# Create uploads directory for local storage fallback
RUN mkdir -p /app/uploads

# Create the non-root user the app actually runs as — this process shells out to FFmpeg/
# native image libraries against untrusted media (curated archive uploads, downloaded stock/
# archive footage); a vulnerability in any of those decoders shouldn't hand over root inside
# the container. The container itself still starts as root (no USER directive here) because
# a Railway Volume mounted at /data arrives owned by root, after this build already ran —
# start.sh/worker-start.sh chown it while briefly still root, then re-exec themselves as
# "app" via gosu before any application code runs, so the app process itself is always
# non-root exactly as before.
RUN groupadd -r app && useradd -r -g app -d /app app \
  && chown -R app:app /app

# Railway injects PORT automatically; default to 3000 for local testing
ENV PORT=3000

# Use start.sh which handles FFmpeg path setup and starts the server
CMD ["sh", "start.sh"]
