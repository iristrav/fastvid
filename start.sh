#!/bin/sh
# Railway/Docker mounts a persistent volume at /data (if attached) when the container is
# created — after this image's build-time `chown -R app:app /app` already ran, and owned by
# root by default. The app always runs as the non-root "app" user (see Dockerfile), so
# without this the app user can never write into /data (CLIP cache, archive-clip-embeddings/
# archive-clip-audits, uploads) — EACCES on every attempt. Fix ownership here while still
# root (the container now starts as root so this is possible), then drop to "app" for the
# rest of this script and the actual node process, preserving the non-root runtime.
echo "[start.sh] Running as uid=$(id -u) gid=$(id -g) ($(id))"
if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    echo "[start.sh] /data exists, owner before chown: $(stat -c '%U:%G (%u:%g)' /data 2>/dev/null || stat -f '%Su:%Sg' /data 2>/dev/null)"
    chown -R app:app /data
    CHOWN_RC=$?
    echo "[start.sh] chown -R app:app /data exit code: $CHOWN_RC, owner after: $(stat -c '%U:%G (%u:%g)' /data 2>/dev/null || stat -f '%Su:%Sg' /data 2>/dev/null)"
  else
    echo "[start.sh] /data does not exist — no Railway Volume mounted on this service"
  fi
  echo "[start.sh] dropping to app user via gosu"
  exec gosu app sh "$0" "$@"
fi

# Ensure FFmpeg is available at a known path before starting the server.
# Railway's Nixpacks installs ffmpeg in the Nix store, but the PATH may not
# include it at runtime. This script finds it and passes it via env var.

echo "[start.sh] Setting up FFmpeg..."

# Try to find ffmpeg in common locations
FFMPEG_PATH=""

# Check if already in PATH
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_PATH=$(command -v ffmpeg)
  echo "[start.sh] Found ffmpeg in PATH: $FFMPEG_PATH"
fi

# Check Nix store (Railway Nixpacks installs ffmpeg here)
if [ -z "$FFMPEG_PATH" ]; then
  FFMPEG_PATH=$(find /nix/store -name "ffmpeg" -type f 2>/dev/null | grep "/bin/ffmpeg$" | head -1)
  if [ -n "$FFMPEG_PATH" ]; then
    echo "[start.sh] Found ffmpeg in Nix store: $FFMPEG_PATH"
  fi
fi

# Check common paths
if [ -z "$FFMPEG_PATH" ]; then
  for p in /usr/local/bin/ffmpeg /usr/bin/ffmpeg /opt/homebrew/bin/ffmpeg; do
    if [ -f "$p" ]; then
      FFMPEG_PATH="$p"
      echo "[start.sh] Found ffmpeg at: $FFMPEG_PATH"
      break
    fi
  done
fi

if [ -n "$FFMPEG_PATH" ]; then
  echo "[start.sh] FFmpeg ready: $FFMPEG_PATH"
  FFMPEG_DIR=$(dirname "$FFMPEG_PATH")
  export PATH="$FFMPEG_DIR:$PATH"
  export FFMPEG_BIN="$FFMPEG_PATH"
  if [ -x "$FFMPEG_DIR/ffprobe" ]; then
    export FFPROBE_BIN="$FFMPEG_DIR/ffprobe"
    echo "[start.sh] FFprobe ready: $FFPROBE_BIN"
  elif command -v ffprobe >/dev/null 2>&1; then
    export FFPROBE_BIN=$(command -v ffprobe)
    echo "[start.sh] FFprobe ready: $FFPROBE_BIN"
  else
    FFPROBE_PATH=$(find /nix/store -name "ffprobe" -type f 2>/dev/null | grep "/bin/ffprobe$" | head -1)
    if [ -n "$FFPROBE_PATH" ]; then
      export FFPROBE_BIN="$FFPROBE_PATH"
      echo "[start.sh] FFprobe ready (nix): $FFPROBE_BIN"
    fi
  fi
  echo "[start.sh] Added $FFMPEG_DIR to PATH"
else
  echo "[start.sh] WARNING: ffmpeg not found, will use ffmpeg-static fallback"
fi


# WORKER_MODE=true lets this same Docker image/CMD run as the queue worker
# instead of the web server — used on hosts (e.g. Coolify) where the deploy
# platform doesn't offer a per-app "custom start command" override, so the
# worker app can't simply invoke worker-start.sh directly like on Railway.
if [ "$WORKER_MODE" = "true" ]; then
  echo "[start.sh] WORKER_MODE=true — starting queue worker instead of web server"
  if [ -z "$TRANSFORMERS_CACHE" ] && [ -d "/data" ]; then
    export TRANSFORMERS_CACHE="/data/transformers-cache"
  fi
  if [ -n "$TRANSFORMERS_CACHE" ]; then
    mkdir -p "$TRANSFORMERS_CACHE" 2>/dev/null || true
    export HF_HOME="${HF_HOME:-$TRANSFORMERS_CACHE}"
    export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$TRANSFORMERS_CACHE}"
    echo "[start.sh] CLIP cache: $TRANSFORMERS_CACHE"
  fi
  if [ -z "$NODE_OPTIONS" ]; then
    export NODE_OPTIONS="--max-old-space-size=1024"
  fi
  exec env FFMPEG_BIN="${FFMPEG_BIN:-$FFMPEG_PATH}" FFPROBE_BIN="${FFPROBE_BIN:-}" node dist/worker.js
fi

echo "[start.sh] Starting server..."
exec env FFMPEG_BIN="${FFMPEG_BIN:-$FFMPEG_PATH}" FFPROBE_BIN="${FFPROBE_BIN:-}" node dist/index.js
