FROM python:3.12-slim

# ffmpeg is not optional: --force-keyframes-at-cuts re-encodes the cut, and the video+audio
# streams the format selector picks have to be merged into one mp4.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

# Railway supplies $PORT. The default keeps `docker run` usable without one.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
