#!/bin/sh
# Ensure FFmpeg is available at a known path before starting the server.
# Railway's Nixpacks installs ffmpeg in the Nix store, but the PATH may not
# include it at runtime. This script finds and symlinks it first.

set -e

echo "[start.sh] Setting up FFmpeg..."

# Try to find ffmpeg in common locations
FFMPEG_PATH=""

# Check if already in PATH
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_PATH=$(command -v ffmpeg)
  echo "[start.sh] Found ffmpeg in PATH: $FFMPEG_PATH"
fi

# Check Nix store (Railway Nixpacks)
if [ -z "$FFMPEG_PATH" ]; then
  FFMPEG_PATH=$(find /nix/store -name "ffmpeg" -type f 2>/dev/null | grep "/bin/ffmpeg$" | head -1)
  if [ -n "$FFMPEG_PATH" ]; then
    echo "[start.sh] Found ffmpeg in Nix store: $FFMPEG_PATH"
  fi
fi

# Check common paths
if [ -z "$FFMPEG_PATH" ]; then
  for p in /usr/bin/ffmpeg /usr/local/bin/ffmpeg /opt/homebrew/bin/ffmpeg; do
    if [ -f "$p" ]; then
      FFMPEG_PATH="$p"
      echo "[start.sh] Found ffmpeg at: $FFMPEG_PATH"
      break
    fi
  done
fi

# Create symlink at /usr/local/bin/ffmpeg if found and not already there
if [ -n "$FFMPEG_PATH" ]; then
  if [ "$FFMPEG_PATH" != "/usr/local/bin/ffmpeg" ]; then
    mkdir -p /usr/local/bin
    ln -sf "$FFMPEG_PATH" /usr/local/bin/ffmpeg 2>/dev/null || true
    echo "[start.sh] Symlinked $FFMPEG_PATH -> /usr/local/bin/ffmpeg"
  fi
  # Export for child processes
  export FFMPEG_PATH="$FFMPEG_PATH"
  echo "[start.sh] FFmpeg ready: $FFMPEG_PATH"
else
  echo "[start.sh] WARNING: ffmpeg not found in any location, will use ffmpeg-static"
fi

echo "[start.sh] Starting server..."
exec node dist/index.js
