# Fastvid

AI-powered documentary video generation platform. Generates videos with voice-over, archival footage, cinematic text overlays, and Wikimedia-sourced imagery.

## Stack
- **Frontend:** React + Vite (TypeScript)
- **Backend:** Express + TypeScript (`server/`)
- **Database:** PostgreSQL
- **Video:** FFmpeg (ffmpeg-static), VP9/WebM for alpha overlays
- **Queue:** Custom video worker (`server/worker.ts`)

## Key files
- `server/videoPipeline.ts` — main video generation pipeline (~17 000 lines)
- `server/cinematicEffectsEngine.ts` — text overlays, screen labels
- `server/documentaryStyle.ts` — Ken Burns, blur-fill, Wikimedia style
- `server/visualMatchingEngine.ts` — Visual Matching Engine V1 (scored Wikimedia sourcing)
- `server/sourcingPolicy.ts` — feature flags (env vars)

## GitHub
- Repo: `https://github.com/iristrav/fastvid`
- Branch: `main`
- Token env var: `GITHUB_PERSONAL_ACCESS_TOKEN`

## User preferences
- **Push every change to GitHub** — after every code change, push the modified files to the `iristrav/fastvid` repo on the `main` branch via the GitHub API using `GITHUB_PERSONAL_ACCESS_TOKEN`. Large files (>1 MB) must be pushed via Python urllib to avoid shell argument-list limits.
- Font: only DejaVu Sans Bold available (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`)
