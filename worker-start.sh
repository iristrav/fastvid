#!/bin/sh
# Railway worker service (fastvid-worker / fastvid Copy):
#   - Start Command: sh worker-start.sh
#   - Config-as-code: railway.worker.json (no healthcheckPath — dashboard path may still stick)
#   - Worker exposes GET /api/health immediately for Railway deploy probes (no full web app)
# Web/API service: railway.json with healthcheckPath /api/health

echo "[worker-start.sh] Setting up FFmpeg..."

FFMPEG_PATH=""

if command -v ffmpeg >/dev/null 2>&1; then
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
  export PATH="$FFMPEG_DIR:$PATH"
  export FFMPEG_BIN="$FFMPEG_PATH"
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
