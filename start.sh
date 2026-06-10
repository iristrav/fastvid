#!/bin/sh
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

echo "[start.sh] Starting server..."
exec env FFMPEG_BIN="${FFMPEG_BIN:-$FFMPEG_PATH}" FFPROBE_BIN="${FFPROBE_BIN:-}" node dist/index.js
