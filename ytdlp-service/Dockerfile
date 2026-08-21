# ytdlp-service — YouTube clip extraction for the FastVid render pipeline.
#
# Single stage on purpose: the runtime needs Python, ffmpeg and yt-dlp anyway, so a builder stage
# would save nothing and only add a way for the two to drift apart.
FROM python:3.12-slim

# ffmpeg does the trimming AND is what yt-dlp itself shells out to for --download-sections and for
# merging separate video/audio streams. Without it the service starts but every request fails.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

# Never run as root: this process executes yt-dlp against arbitrary remote content.
RUN useradd --create-home --shell /usr/sbin/nologin ytdlp \
  && chown -R ytdlp:ytdlp /srv
USER ytdlp

# Railway injects PORT; the default keeps `docker run -p 8000:8000` working locally.
ENV PORT=8000
EXPOSE 8000

# Health check hits the same endpoint the render worker can call, so a green container means the
# binaries are actually present rather than just that Python started.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8000')}/health\").read()" || exit 1

# One worker: each request already spawns yt-dlp and ffmpeg, so parallelism is bounded inside the
# app by MAX_CONCURRENT_DOWNLOADS. Multiple uvicorn workers would multiply that ceiling silently.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --timeout-keep-alive 65"]
