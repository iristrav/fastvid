#!/bin/sh
# Railway worker service (fastvid-worker / fastvid Copy):
#   - Start Command: sh worker-start.sh
#   - Config-as-code: railway.worker.json (no healthcheckPath — dashboard path may still stick)
#   - Worker exposes GET /api/health immediately for Railway deploy probes (no full web app)
# Web/API service: railway.json with healthcheckPath /api/health

# Railway/Docker mounts a persistent volume at /data (if attached) when the container is
# created — after this image's build-time `chown -R app:app /app` already ran, and owned by
# root by default. The app always runs as the non-root "app" user (see Dockerfile), so
# without this the app user can never write into /data (CLIP cache, archive-clip-embeddings/
# archive-clip-audits, uploads) — EACCES on every attempt. Fix ownership here while still
# root (the container now starts as root so this is possible), then drop to "app" for the
# rest of this script and the actual node process, preserving the non-root runtime.
echo "[worker-start.sh] Running as uid=$(id -u) gid=$(id -g) ($(id))"
if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    echo "[worker-start.sh] /data exists, owner before chown: $(stat -c '%U:%G (%u:%g)' /data 2>/dev/null || stat -f '%Su:%Sg' /data 2>/dev/null)"
    chown -R app:app /data
    CHOWN_RC=$?
    echo "[worker-start.sh] chown -R app:app /data exit code: $CHOWN_RC, owner after: $(stat -c '%U:%G (%u:%g)' /data 2>/dev/null || stat -f '%Su:%Sg' /data 2>/dev/null)"
  else
    echo "[worker-start.sh] /data does not exist — no Railway Volume mounted on this service"
  fi
  echo "[worker-start.sh] dropping to app user via gosu"
  exec gosu app sh "$0" "$@"
fi

echo "[worker-start.sh] Setting up FFmpeg..."

# CLIP model cache on persistent Railway volume (survives redeploys)
if [ -z "$TRANSFORMERS_CACHE" ] && [ -d "/data" ]; then
  export TRANSFORMERS_CACHE="/data/transformers-cache"
fi
if [ -n "$TRANSFORMERS_CACHE" ]; then
  mkdir -p "$TRANSFORMERS_CACHE" 2>/dev/null || true
  export HF_HOME="${HF_HOME:-$TRANSFORMERS_CACHE}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$TRANSFORMERS_CACHE}"
  echo "[worker-start.sh] CLIP cache: $TRANSFORMERS_CACHE"
fi
if [ -z "$NODE_OPTIONS" ]; then
  export NODE_OPTIONS="--max-old-space-size=1024"
fi

FFMPEG_PATH=""

# VIDEO 649 — the bundled ffmpeg-static (7.0.2) is the build of choice: it renders the transition
# graph the system ffmpeg (Debian 5.1) could not configure, and does everything else the same.
# ffprobe is not bundled and stays with the system build (below).
APP_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLED_FFMPEG="$APP_DIR/node_modules/ffmpeg-static/ffmpeg"
if [ -f "$BUNDLED_FFMPEG" ]; then
  chmod +x "$BUNDLED_FFMPEG" 2>/dev/null || true
  if "$BUNDLED_FFMPEG" -version >/dev/null 2>&1; then
    FFMPEG_PATH="$BUNDLED_FFMPEG"
    echo "[worker-start.sh] Using the bundled ffmpeg-static (build of choice): $FFMPEG_PATH — $("$BUNDLED_FFMPEG" -version 2>/dev/null | head -1)"
  else
    echo "[worker-start.sh] bundled ffmpeg-static present but cannot run — the system build is used"
  fi
fi

if [ -z "$FFMPEG_PATH" ] && command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_PATH=$(command -v ffmpeg)
  echo "[worker-start.sh] Found ffmpeg in PATH: $FFMPEG_PATH"
fi

if [ -z "$FFMPEG_PATH" ]; then
  FFMPEG_PATH=$(find /nix/store -name "ffmpeg" -type f 2>/dev/null | grep "/bin/ffmpeg$" | head -1)
  if [ -n "$FFMPEG_PATH" ]; then
    echo "[worker-start.sh] Found ffmpeg in Nix store: $FFMPEG_PATH"
  fi
fi

if [ -z "$FFMPEG_PATH" ]; then
  for p in /usr/local/bin/ffmpeg /usr/bin/ffmpeg /opt/homebrew/bin/ffmpeg; do
    if [ -f "$p" ]; then
      FFMPEG_PATH="$p"
      echo "[worker-start.sh] Found ffmpeg at: $FFMPEG_PATH"
      break
    fi
  done
fi

if [ -n "$FFMPEG_PATH" ]; then
  echo "[worker-start.sh] FFmpeg ready: $FFMPEG_PATH"
  FFMPEG_DIR=$(dirname "$FFMPEG_PATH")
  export FFMPEG_BIN="$FFMPEG_PATH"
  # The bundled directory holds no ffprobe; PATH is extended only for a system directory.
  if [ "$FFMPEG_PATH" != "$BUNDLED_FFMPEG" ]; then
    export PATH="$FFMPEG_DIR:$PATH"
  fi
  if [ -x "$FFMPEG_DIR/ffprobe" ]; then
    export FFPROBE_BIN="$FFMPEG_DIR/ffprobe"
    echo "[worker-start.sh] FFprobe ready: $FFPROBE_BIN"
  elif command -v ffprobe >/dev/null 2>&1; then
    export FFPROBE_BIN=$(command -v ffprobe)
    echo "[worker-start.sh] FFprobe ready: $FFPROBE_BIN"
  else
    FFPROBE_PATH=$(find /nix/store -name "ffprobe" -type f 2>/dev/null | grep "/bin/ffprobe$" | head -1)
    if [ -n "$FFPROBE_PATH" ]; then
      export FFPROBE_BIN="$FFPROBE_PATH"
      echo "[worker-start.sh] FFprobe ready (nix): $FFPROBE_BIN"
    fi
  fi
  echo "[worker-start.sh] Added $FFMPEG_DIR to PATH"
else
  echo "[worker-start.sh] WARNING: ffmpeg not found, will use ffmpeg-static fallback"
fi

echo "[worker-start.sh] Starting video queue worker..."
exec env \
  WORKER_MODE=true \
  FFMPEG_BIN="${FFMPEG_BIN:-$FFMPEG_PATH}" \
  FFPROBE_BIN="${FFPROBE_BIN:-}" \
  node dist/worker.js
