FROM python:3.12-slim

# ffmpeg is not optional: --force-keyframes-at-cuts re-encodes the cut, and the video+audio
# streams the format selector picks have to be merged into one mp4.
#
# nodejs is not optional either, and its absence was invisible. yt-dlp needs a JavaScript runtime
# to answer YouTube's challenge, and its own help says only "deno" is enabled by default — of the
# four it supports (deno, node, quickjs, bun) this image had NONE. A python:3.12-slim base carries
# no JS runtime at all, so every video that required a challenge could only fail, whatever the
# network looked like.
#
# node rather than deno because it is in Debian's own archive and installs with the same apt line
# as ffmpeg, so the image has one package manager and no download step to go stale. deno stays
# enabled in `_ydl_options` as the higher-priority runtime, so an image that later gains it uses
# it without a code change — yt-dlp picks the highest priority runtime that is enabled AND
# available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

# Railway supplies $PORT. The default keeps `docker run` usable without one.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
