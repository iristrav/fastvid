FROM python:3.12-slim

# ffmpeg is not optional: --force-keyframes-at-cuts re-encodes the cut, and the video+audio
# streams the format selector picks have to be merged into one mp4.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

# A JAVASCRIPT RUNTIME YT-DLP WILL ACTUALLY ACCEPT.
#
# yt-dlp needs a JS runtime to answer YouTube's challenge. An earlier revision installed `nodejs`
# from Debian's own archive, on the reasoning that one package manager is simpler than a download
# step. That reasoning was sound and the result did not work, silently:
#
#     [debug] JS runtimes: node-20.20.2 (unsupported)
#
# yt-dlp/utils/_jsruntime.py:120 —  NodeJsRuntime.MIN_SUPPORTED_VERSION = (22, 0, 0)
#
# Debian ships node 18.20 (bookworm) and 20.19 (trixie). Neither reaches the floor, so yt-dlp
# found the runtime, rejected it, and fell back to the JS-less client set — extractor/youtube/
# _video.py:2973 picks `_DEFAULT_JSLESS_CLIENTS = ('visionos',)` over `_DEFAULT_CLIENTS =
# ('visionos', 'web')` whenever no supported runtime is available. Every client that needs the JS
# player (web, mweb, tv, tv_simply, web_embedded, web_music, web_safari) was therefore unreachable
# in production, whatever the network or the PO tokens looked like.
#
# It was invisible because yt-dlp warns about exactly this — "No supported JavaScript runtime
# could be found" — through `report_warning`, and `main.py` sets `no_warnings: True` without
# `verbose`, which makes that call a no-op (YoutubeDL.py report_warning). The warning has never
# appeared in a log line.
#
# So: the official Linux binary, pinned to an exact version and checked against the SHA256 the
# Node project publishes for that file. Not `latest`, not a version range, and not a third-party
# apt repository — a download step that can silently change what it installs would reintroduce the
# same class of failure this replaces.
#
# deno stays enabled in `_ydl_options` as the higher-priority runtime, so an image that later
# gains one uses it without a code change.
#
# ── WHY IT IS UNPACKED INTO /usr/local AND NOT SOMEWHERE ON $PATH ───────────────────────────
#
# yt-dlp does NOT look up `node` on PATH first. utils/_jsruntime.py `_find_exe` starts at Python's
# own scripts directory — `sysconfig.get_path('scripts')`, which is /usr/local/bin on this base —
# and only falls back to a bare name (resolved via PATH) when nothing is there. A newer node
# installed under /opt and put first on PATH is therefore IGNORED while an older /usr/local/bin/node
# keeps being used. That was measured, not assumed: on a machine with node 22 first on PATH and a
# node 20 symlink in /usr/local/bin, yt-dlp still reported `node-20.20.2 (unsupported)`.
#
# `--strip-components=1` into /usr/local puts the binary at /usr/local/bin/node — the first place
# yt-dlp looks. Moving this install elsewhere reintroduces the silent failure it replaces.
ARG NODE_VERSION=22.23.2
ARG NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
RUN set -eux; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
        --no-same-owner --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    rm "node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    # Fail the BUILD rather than the render if the runtime is not what yt-dlp requires. A version
    # below the floor is the exact defect this replaces, and it must never reach production again.
    node --version; \
    node -e 'const m=+process.versions.node.split(".")[0]; if(m<22){console.error("node "+process.versions.node+" is below yt-dlp\x27s floor of 22");process.exit(1)}'

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

# Railway supplies $PORT. The default keeps `docker run` usable without one.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
