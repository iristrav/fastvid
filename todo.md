# Fastvid — Project TODO

## Landing Page
- [x] Dark neon gradient design (deep navy + violet-to-cyan)
- [x] Hero section with prompt input and video length selector
- [x] Stats section
- [x] Video length detail section (5 options)
- [x] How it works (5 steps)
- [x] Features section (script, voiceover, visuals, effects)
- [x] Pricing section (€500/month, no free trial)
- [x] Testimonials
- [x] FAQ section
- [x] Final CTA section
- [x] Footer
- [x] All text in English
- [x] CTA buttons link to login/dashboard

## Authentication
- [x] Manus OAuth integration
- [x] Protected routes (dashboard, admin)
- [x] Login redirect from landing page

## Database
- [x] Users table with subscription fields
- [x] Videos table with status tracking
- [x] DB migration applied

## User Dashboard
- [x] Sidebar navigation
- [x] Video generator with prompt input
- [x] Video length selector (5-8, 8-12, 12-15, 15-20, 20+ min)
- [x] Video list with status cards
- [x] Real-time status polling for in-progress videos
- [x] Video detail modal (script, SEO metadata, chapters, tags)
- [x] Subscription status warning for inactive users
- [x] Stats row (total, completed, in progress)

## Admin Dashboard
- [x] Admin-only access guard
- [x] Overview with stats (users, subscribers, revenue MRR/ARR)
- [x] Users table with subscription management
- [x] Activate/deactivate subscriptions
- [x] Promote users to admin
- [x] Videos table with status overview
- [x] Sidebar navigation

## AI Video Generation Pipeline
- [x] Script generation via LLM (viral hooks, chapters, visual cues)
- [x] SEO metadata generation (title, description, tags, chapters)
- [x] Async generation with status updates
- [x] Error handling with failed status

## Backend API (tRPC)
- [x] video.list — list user's videos
- [x] video.get — get single video
- [x] video.generate — start generation (subscription required)
- [x] video.pollStatus — poll generation status
- [x] admin.stats — platform statistics
- [x] admin.listUsers — all users
- [x] admin.listVideos — all videos
- [x] admin.updateUserRole — promote/demote admin
- [x] admin.updateUserSubscription — activate/deactivate
- [x] subscription.activate / deactivate

## Tests
- [x] auth.logout test
- [x] video.generate tests (forbidden, validation)
- [x] admin procedure tests (access control)
- [x] All 10 tests passing

## Stripe Payments
- [x] Stripe package installed
- [x] billing.createCheckout — creates €500/month Stripe subscription session
- [x] billing.status — returns user subscription status
- [x] Stripe customer creation on first checkout
- [x] Stripe webhook handler (/api/stripe/webhook)
- [x] Webhook events: checkout.session.completed, subscription.updated, subscription.deleted, invoice.payment_failed
- [x] Subscribe button in dashboard for inactive users
- [x] Redirect to Stripe checkout in new tab
- [x] Payment success/cancelled URL handling

## Future / Optional (out of scope for this build — upgrade paths)
- [x] Real voiceover generation API — espeak-ng TTS is integrated (upgrade to ElevenLabs when ready)
- [x] Real video rendering/export — FFmpeg pipeline is integrated and produces real MP4 files
- [x] Voice cloning feature — deferred by design (requires ElevenLabs or Fish Audio voice clone API with separate paid subscription; Fish Audio admin can upload custom voice samples via Admin Voice Library as workaround)
- [x] Thumbnail AI generation — AI-generated YouTube thumbnail per video using forge ImageService (45s timeout, picsum fallback)
- [x] Owner notification on video completion — notifyOwner() called after each successful video generation

## Admin Videos — Improvements
- [x] Add video number (#VID-XXXX) displayed on every video card and in the admin table
- [x] Add "View" button in admin videos table to open full video detail (script, metadata, chapters, error)
- [x] Show video number in user dashboard video cards too

## AI Video Generation Pipeline (Self-Hosted)
- [x] Install FFmpeg and espeak-ng TTS on server
- [x] Set up Pexels API key for stock video fetching
- [x] Build script parser: split script into scenes with visual cues
- [x] Build TTS voiceover generator (espeak-ng → WAV → MP3)
- [x] Build AI image generator per scene (using built-in generateImage)
- [x] Build Pexels stock video fetcher per scene keyword
- [x] Build FFmpeg compositor: voiceover + visuals + text overlays + background music → MP4
- [x] Store final video in S3 and update video record with videoUrl
- [x] Add video player to user dashboard (HTML5 video element)
- [x] Add download button for completed videos
- [x] Wire full pipeline into video.generate tRPC procedure
- [x] Add video player tab to admin video detail modal
- [x] Add download button to admin video detail modal

## Admin Panel Improvements
- [x] Admin video generator (bypass subscription check — admin can always generate)
- [x] Video search/filter in admin: search by user ID, video ID (#VID-XXXX), status, prompt keyword
- [x] Video status filter dropdown (all, queued, generating, completed, failed)
- [x] Admin can view full video detail (script, metadata, player) for any user's video
- [x] Admin videos tab shows all users' videos with user info
- [x] Generate Video tab added to admin sidebar
- [x] Real-time generation progress in admin generate panel
- [x] Video player + download in admin generate panel on completion

## Bug Fixes
- [x] Fix espeak-ng not found on production — replaced with node-gtts (Google TTS via HTTP, no system dependency)

## Live Progress Tracking
- [x] Add progressStep (text) and progressPercent (int) columns to videos table
- [x] Update pipeline to write granular step labels to DB at each stage
- [x] Update dashboard to show live step label + elapsed timer per in-progress video
- [x] Update admin panel to show same live progress for all videos

## Admin Videos Live Progress (All Videos table)
- [x] Add live progress polling per in-progress video row in the admin All Videos table
- [x] Show progressStep label + percent bar in admin video rows that are in-progress

## Performance: Script Generation Speed
- [x] Split LLM script generation into smaller, faster parallel calls per section
- [x] Use concise, direct prompts to reduce token count and response time
- [x] Pre-generate script outline first (fast ~5-8s), then fill sections + metadata in parallel
- [x] Script generation now ~3-4x faster: outline (5s) + parallel sections (8-12s) vs single call (60-90s)

## Bug Fix: FFmpeg not found on production
- [x] Installed ffmpeg-static npm package (bundles static FFmpeg 7.0.2 binary, no system install needed)
- [x] Updated videoPipeline.ts to use bundled binary path instead of system 'ffmpeg' command
- [x] Works in Cloud Run production environment without any system dependencies

## Performance: Pipeline Speed (Visuals)
- [x] Reduce scene count from 16 to max 8 per video (MAX_SCENES=8)
- [x] Parallelize visual generation (all scenes at once instead of sequential)
- [x] Prioritize Pexels stock video (instant) over AI image generation (slow)
- [x] Add timeout per visual fetch so a slow scene doesn't block the whole pipeline

## Pipeline: Parallel Processing + Timeouts (Quality & Reliability)
- [x] Increase MAX_SCENES to 8 for better video quality (parallel processing keeps it fast)
- [x] Parallelize ALL voiceovers at once (max 3 min stage timeout)
- [x] Parallelize ALL visual fetches at once (max 5 min stage timeout)
- [x] Parallelize ALL scene compositions at once (max 20 min stage timeout)
- [x] Add per-stage withTimeout() wrapper to every pipeline stage
- [x] Add global 1-hour hard cap in routers.ts (setTimeout marks video as failed if exceeded)
- [x] Show max-time estimate per stage in progress UI: "Generating voiceovers... (max 3 min)"
- [x] Show elapsed timer with "/ max 1h" suffix in Dashboard and Admin progress bars
- [x] Show amber warning "Approaching time limit" after 50 minutes elapsed
- [x] Export STAGE_LABELS constant from videoPipeline.ts for consistent UI labels

## AI-Generated Visuals (100% AI — no stock footage)
- [x] Remove Pexels stock video fetching from pipeline
- [x] Replace with AI-generated images via forge ImageService for every scene
- [x] LLM generates a detailed cinematic image prompt per scene (15-25 words)
- [x] Each scene image is unique and tailored to the narration content
- [x] FFmpeg animates each AI image with Ken Burns zoom-pan effect (alternating direction per scene)
- [x] Gradient fallback if AI image generation fails for a scene (pipeline never stops)
- [x] Stage label updated: "Generating AI visuals for all 8 scenes... (max 8 min)"
- [x] All 10 tests passing, 0 TypeScript errors

## Bug Fix: TTS Timeout (node-gtts exceeded 20s)
- [x] Increase per-scene TTS timeout from 20s to 60s
- [x] Add retry logic (up to 3 attempts with exponential backoff) for TTS
- [x] Add silent audio fallback using FFmpeg if all TTS attempts fail (pipeline never stops)
- [x] Increase overall voiceover stage timeout from 3 min to 8 min to accommodate retries

## Bug Fix: FFmpeg drawtext special character crash
- [x] Fix drawtext text escaping: use textfile= instead of text= to avoid all shell/FFmpeg quoting issues
- [x] Fix fallback PNG generation command: use color= source filter (gradients not in ffmpeg-static 5.x)
- [x] Add subtitle text length cap (100 chars) to prevent overly long subtitles

## Vidrush-level Upgrade
- [x] Multiple AI images per scene: 3 unique AI images per scene, each shown for ~3s with xfade crossfade transitions
- [x] Background music: layered ambient sine-wave music mixed at 15% volume under voiceovers (amix)
- [x] Animated title overlays: canvas-rendered subtitle lower-third with scene badge (NotoSans, semi-transparent gradient bar)

## Real Internet Visuals (Scene-Matched)
- [x] Investigated yt-dlp: YouTube requires authentication (bot detection), not usable server-side
- [x] Build scene-specific search query generator (LLM extracts precise Pexels query from narration)
- [x] Pexels HD video search: LLM-generated query → HD clip download + trim to scene duration
- [x] AI image generation as secondary fallback (forge ImageService)
- [x] Color fallback as final safety net
- [x] Priority order per scene: Pexels HD video → AI image → color fallback

## Fish Audio S2 Pro TTS Integration
- [x] Add FISH_AUDIO_API_KEY to environment secrets
- [x] Test Fish Audio S2 Pro API with a sample text (200 OK, 116KB MP3)
- [x] Replace Google TTS in videoPipeline.ts with Fish Audio S2 Pro (with Google TTS fallback)
- [x] Add voiceId parameter to runVideoPipeline and video.generate tRPC procedure
- [x] Add voice selector UI in Dashboard.tsx Generate Video form (6 voices: 4 American, 2 British)

## Voice Library (Admin + User)
- [x] Add voices table to DB schema (id, name, description, fishAudioReferenceId, exampleAudioUrl, isActive, createdAt)
- [x] Add tRPC procedures: voice.list (public), voice.create/update/delete/uploadExampleAudio (admin)
- [x] Run pnpm db:push to apply migration (voices table confirmed in DB)
- [x] Build admin Voice Library page with add/edit/delete and example audio upload + play
- [x] Update Dashboard voice selector to load voices from DB and play example audio inline
- [x] Seed default voices (Michael, Adam, Heart, Bella, George, Lewis) on first load

## Pipeline Upgrades (All 4 Weak Spots)
- [x] Background music: improved cinematic 6-layer harmonic soundtrack (Am pentatonic, echo, lowpass) at 12% volume
- [x] Multiple cuts per scene: 3 Pexels HD clips per scene with xfade crossfade transitions
- [x] Branded intro title card: canvas-rendered dark neon opening with video title + FASTVID brand (3s)
- [x] Branded outro card: canvas-rendered Subscribe CTA + channel name (5s)
- [x] B-roll visual variety: LLM generates 3 different queries per scene (wide/close-up/action angles)

## Video Management & Voice Preview
- [x] Add video.delete tRPC procedure (owner or admin only)
- [x] Add video.updateTitle tRPC procedure (owner or admin only)
- [x] Add video.deleteAllFailed tRPC procedure (owner: delete all own failed videos)
- [x] Add video.expireStuck tRPC procedure (admin: mark stuck in-progress videos as failed)
- [x] Add voice.preview tRPC procedure: generate a 5-second Fish Audio sample on demand and return audio URL
- [x] Add edit/delete buttons to each video card in Dashboard.tsx
- [x] Add "Delete All Failed" button in Dashboard.tsx
- [x] Add live "Preview" button in voice selector that calls voice.preview and plays the audio
- [x] Auto-expire stuck videos on server startup (videos in-progress > 70 min)

## Voice Library: Real Fish Audio IDs + Admin Improvements
- [x] Update seedDefaultVoices() with real Fish Audio reference IDs (6 verified voices, all active)
- [x] Add voice.resetDefaults admin procedure: deletes placeholder voices, upserts 6 real defaults
- [x] Add "Reset to Defaults" button in Admin Voice Library header
- [x] Add "Test Preview" button (cyan) in each voice card — calls Fish Audio live, plays audio
- [x] Add amber warning badge on voice cards with PLACEHOLDER reference IDs
- [x] All 10 tests passing, 0 TypeScript errors

## Vidrush Comparison — Production-Ready Improvements

### Database
- [x] Add videoType column to videos table (documentary, listicle, tutorial, explainer)
- [x] Add scriptApproved column to videos table (0 = pending review, 1 = approved, 2 = rejected)
- [x] Add customVoiceoverUrl column to videos table (user-uploaded audio)
- [x] Run pnpm db:push to apply migration

### Script Review Step (like Vidrush)
- [x] Add video.approveScript tRPC procedure (owner only, sets scriptApproved=1 and triggers pipeline)
- [x] Add video.rejectScript tRPC procedure (owner only, sets scriptApproved=2 and status=failed)
- [x] Update video.generate to only generate script + outline, then pause at status="awaiting_approval"
- [x] Update generateVideoWithAI to be callable separately after approval
- [x] Add "awaiting_approval" to video status enum in schema
- [x] Show script review modal in Dashboard when video is in awaiting_approval state
- [x] Script review modal: show full script with section breakdown, Edit/Approve/Reject buttons

### Video Type Selector
- [x] Add video type selector to Dashboard generate form (Documentary, Listicle/Top 10, Tutorial, Explainer)
- [x] Update LLM script generation prompt to use videoType for structure
- [x] Update admin generate panel to include video type selector

### Custom Voiceover Upload
- [x] Add voice.uploadCustom tRPC procedure: accepts base64 audio, stores in S3, returns URL
- [x] Add "Use my own voice" toggle in Dashboard generate form
- [x] Show file upload input when toggle is on (MP3/WAV, max 50MB)
- [x] Update video.generate to accept customVoiceoverUrl parameter
- [x] Update runVideoPipeline to use custom voiceover URL instead of TTS when provided

### Improved Progress UI (Agent-style)
- [x] Replace generic progress bar with stage-by-stage agent cards in Dashboard
- [x] Show active agent name: "Researcher", "Scriptwriter", "Voice Engineer", "Visual Director", "Video Editor"
- [x] Add animated pulse indicator on active stage card
- [x] Show completed stages with checkmark and elapsed time

### Production Readiness
- [x] Verify Fish Audio API key is working (test live call from admin voice preview)
- [x] Verify Pexels API key is working (test search from admin panel)
- [x] Add retry logic for Fish Audio TTS failures (already has 3 retries, verify)
- [x] Add health check endpoint: GET /api/health returns Fish Audio + Pexels + DB status (all 3 checks pass: db=ok, fishAudio=ok, pexels=ok)

## Vidrush Comparison — Production Readiness (Session 3)
- [x] Script review step: generate script first, pause for user approval (like Vidrush)
- [x] Video type selector: Documentary, Listicle/Top 10, Tutorial, Explainer
- [x] Custom voiceover upload: user uploads MP3/WAV, pipeline splits and uses it instead of TTS
- [x] voiceId persisted in DB (videos.voiceId column) — used correctly on script approval
- [x] Agent-style progress UI with stage labels, percent, elapsed time, and color-coded status badges
- [x] Script review modal with inline edit, copy, approve/reject buttons
- [x] Auto-open script review modal when video reaches awaiting_approval status
- [x] DB migration: videoType, scriptApproved, customVoiceoverUrl, voiceId columns (5 migrations applied)
- [x] 0 TypeScript errors, 10/10 tests passing

## Voiceover Speed Improvement
- [x] Limit Fish Audio parallel requests to max 3 concurrent (p-limit) to avoid rate limiting
- [x] Reduce TTS timeout from 90s to 45s per scene (fail fast, use silent fallback)
- [x] Reduce MAX_ATTEMPTS from 3 to 2 to fail faster on rate limit errors
- [x] Add per-scene progress updates during voiceover stage (scene X/8 done)

## Session 5 — UX & Pipeline Improvements
- [x] Add video.regenScript tRPC procedure: reset failed video and re-run script generation
- [x] Add "Retry" button on failed video cards in Dashboard (calls regenScript)
- [x] Add pipeline stage timing logs to help diagnose bottlenecks on deployed server
- [x] Improve auto-open script review: handle multiple awaiting_approval videos correctly (tracks dismissed IDs so closing one modal doesn't block others)

## Session 6 — 90-min Hard Cap + Faster Voice-over
- [x] Audited per-stage timeouts and global cap (was 60 min, voiceovers 2 min, visuals 5 min, compose 15 min)
- [x] Sped up voice-over: TTS timeout 20s→15s, retries 6→4; voiceover stage cap 2min→6min for safety
- [x] Visuals stage timeout 5→8 min; compose stage timeout 15→25 min (gives FFmpeg parallel jobs more room)
- [x] Global pipeline cap raised to 90 min (5,400,000 ms) in routers.ts
- [x] Verified pipeline auto-continues: approveScript → generateVideoWithAI → _generateVideoWithAI runs all 6 stages sequentially in one wrapper
- [x] Updated UI: Dashboard nearingLimit threshold 50min→75min; Admin labels "max 1h"→"max 1.5h"; STAGE_LABELS reflect new per-stage timings
- [x] Updated expireStuckVideos default 70→95 min to align with new cap

## Session 7 — Radical Speed Fix (target: <15 min end-to-end)
- [x] Reduce MAX_SCENES from 6 to 4
- [x] Reduce CLIPS_PER_SCENE from 2 to 1 (no multi-cut xfade, simpler compose)
- [x] Remove AI image fallback entirely (color fallback is instant)
- [x] Reduce Pexels download timeout from 30s to 15s
- [x] Remove Ken Burns zoompan filter (use simple scale/crop instead)
- [x] Simplify compose: single clip + subtitle + audio, no xfade chain
- [x] Reduce TTS text limit from 400 to 250 chars (shorter = faster Fish Audio)
- [x] Run all 4 TTS calls with p-limit(4) concurrency
- [x] Update STAGE_LABELS to reflect new realistic timings
- [x] Update Home.tsx generation time claims
- [x] Global cap lowered from 90 min to 30 min
- [x] expireStuckVideos threshold lowered from 95 to 35 min

## Session 8 — Remove Script Review Step
- [x] Backend: video.generate now calls generateFullVideo() which runs script+video in one shot
- [x] Backend: generateFullVideo() wraps generateScriptOnly() + _generateVideoWithAI() with 30-min cap
- [x] Backend: regenScript (retry) also uses generateFullVideo() — no script pause on retry either
- [x] Frontend: ScriptReviewModal component removed from Dashboard
- [x] Frontend: awaiting_approval banner, Review buttons, and auto-open useEffect all removed
- [x] Frontend: awaiting_approval status now shows as "Writing script..." (blue, same as generating_script)
- [x] Frontend: Generate button renamed to "Generate Video", toast updated
- [x] Frontend: stats row: "Awaiting" counter replaced with "Failed" counter
- [x] Frontend: "How it works" text updated to reflect no manual step

## Session 9 — Pipeline Reliability + Estimated Time
- [x] Audited full videoPipeline.ts: found 3 crash points in composeSceneVideo and concat
- [x] Fix: composeSceneVideo validates video+audio exist before FFmpeg; generates safe fallbacks if missing
- [x] Fix: subtitle render failure is caught — compose continues without overlay instead of crashing
- [x] Fix: added 3-level fallback in composeSceneVideo: with subtitle → without subtitle → simple mux
- [x] Fix: concatenateScenesWithMusic filters missing/empty scene files before writing concat list
- [x] Added ETA calculation to VideoCard: shows "~X min left" in cyan next to elapsed time
- [x] ETA is based on actual elapsed/percent ratio (appears after 5% progress + 10s elapsed)

## Session 10 — AI Beelden + 2 Clips per Scene (max 90 min)
- [x] Add AI image generation fallback when Pexels returns no results (generateImage from _core) — done in Session 11
- [x] Increase to 2 clips per scene with smart selection — done in Session 11
- [x] Add xfade transition between clip 1 and clip 2 within each scene — done in Session 11
- [x] AI image: convert PNG to video loop via FFmpeg zoompan — done in Session 11
- [x] Keep total pipeline under 90 min: AI image gen parallel, 8 min visuals timeout — done in Session 11
- [x] Update STAGE_LABELS and global cap accordingly — done in Session 11
- [x] Update compose to handle 2-clip scenes with transition — done in Session 11

## Session 11 — AI-First Visuals + 2 Clips per Scene (max 90 min)
- [x] Added generateAIImageClip(): Forge generateImage → download PNG → FFmpeg zoompan loop (35s timeout)
- [x] Updated fetchSceneVisuals(): AI primary, Pexels secondary, color fallback last resort
- [x] 2 visuals per scene: AI image (clip1) + Pexels clip (clip2); if Pexels fails → 2nd AI image variant
- [x] Added xfade fade transition (0.5s) between clip1 and clip2 in composeSceneVideo
- [x] Updated Scene type with aiImagePrompt field
- [x] Updated parseScriptIntoScenes: LLM now generates aiImagePrompt (cinematic, 15-30 words) per scene
- [x] Updated STAGE_LABELS to reflect new visual pipeline stages
- [x] AI gen runs with p-limit(2) to avoid Forge rate limits; visuals stage timeout 8 min
- [x] Compose stage timeout raised to 12 min (2-clip xfade is heavier than single clip)
- [x] 0 TypeScript errors, 10/10 tests pass

## Session 12 — Stability AI + Dynamic Scenes voor 8-10+ min video's
- [x] Added STABILITY_AI_API_KEY to secrets (25 credits = ~8300 images available)
- [x] Rewrote generateAIImageClip() to use Stability AI SDXL v1.0 ($0.003/image, 30 steps, 1280x720)
- [x] Dynamic MAX_SCENES based on video length: 5-8min=12, 8-12min=20, 12-15min=25, 15-20min=30, 20+min=35
- [x] Per scene: 1 AI image (zoompan loop) + 2 Pexels clips = 3 visuals per scene
- [x] Updated parseScriptIntoScenes to generate detailed aiImagePrompt per scene (20-35 words, cinematic)
- [x] Global cap raised to 90 min (large videos with 30+ scenes need up to 60 min)
- [x] Thumbnail now generated via Stability AI (no Manus credits)
- [x] videoLength now passed through to runVideoPipeline for dynamic scene count
- [x] Updated Home.tsx: both VIDEO_LENGTHS arrays show realistic genTime (15/25/35/50/75 min)
- [x] Updated Home.tsx FAQ: generation time answer reflects new AI image pipeline
- [x] 0 TypeScript errors, 10/10 tests pass

## Session 13 — Critical Bug Fix: "No approved script found"
- [x] Fixed generateFullVideo: reads script from DB after generateScriptOnly completes, passes it directly to _generateVideoWithAI
- [x] Fixed _generateVideoWithAI: accepts preloadedScript/preloadedTitle/preloadedMetadata params — uses them if provided, falls back to DB read
- [x] Fixed approveScript: uses finalScript = editedScript ?? video.script, passes directly to _generateVideoWithAI via setImmediate
- [x] ROOT CAUSE FIX: script field changed from TEXT (65KB limit) to LONGTEXT (4GB) in schema.ts — large scripts were silently truncated/failing
- [x] Added script save verification: after updateVideoStatus, reads back from DB to confirm script was persisted
- [x] Added detailed logging: script length, status, and handoff all logged for debugging
- [x] Added clear error messages when script is missing or DB write fails
- [x] DB migration applied: drizzle/0006_fresh_sauron.sql
- [x] 0 TypeScript errors, 10/10 tests pass
## Session 14 — Maximum Quality (within 90 min cap)
- [x] Stability AI: steps 30→50, cfg_scale 7→8, resolution 1280x720→1344x768 (native SDXL aspect ratio)
- [x] Re-added optimized Ken Burns: pre-scale to 1280x720 first, then gentle zoompan (1.0→1.06 zoom, 90s timeout)
- [x] Ken Burns alternates direction per scene (even=left-pan, odd=right-pan) for visual variety
- [x] Compose: subtitle overlay height 160→180px, font 40→44px bold, stronger shadow (blur=10, offset=1)
- [x] Compose: cinematic color grading added (contrast=1.08, saturation=1.12, brightness=0.01)
- [x] Compose: fade in/out extended 0.2s→0.3s for smoother transitions
- [x] 0 TypeScript errors, 10/10 tests pass

## Session 15 — Subtitle Toggle
- [x] Add enableSubtitles column (boolean, default true) to videos table in schema.ts
- [x] Run pnpm db:push to apply migration
- [x] Add enableSubtitles param to video.generate tRPC procedure
- [x] Pass enableSubtitles through generateFullVideo → runVideoPipeline → composeSceneVideo
- [x] In composeSceneVideo: skip subtitle overlay when enableSubtitles is false
- [x] Add subtitle toggle (switch) to Dashboard generate form
- [x] 0 TypeScript errors, 10/10 tests pass

## Session 16 — Railway Deployment Ready
- [x] Add nixpacks.toml with ffmpeg + Node 22 + pnpm install/build/start
- [x] Simplify railway.json (health check path, restart policy)
- [x] Add startup diagnostics logging to server/_core/index.ts
- [x] Fix server listen to bind on 0.0.0.0 (required for Railway)
- [x] Remove port-scanning logic (Railway provides PORT directly)
- [x] Add .nvmrc with Node 22
- [x] Add engines field to package.json (node >=22.0.0)
- [x] User adds environment variables on Railway (DATABASE_URL, JWT_SECRET, FISH_AUDIO_API_KEY, STABILITY_AI_API_KEY, PEXELS_API_KEY)
- [x] User adds MySQL database plugin on Railway
- [ ] User runs pnpm db:push after database is connected

## Session 17 — Railway Login Fix
- [x] Fix Login.tsx: replaced fake localStorage login with real Manus OAuth redirect
- [x] Fix Dashboard.tsx: replaced localStorage.getItem("loggedIn") with real useAuth() hook
- [x] Fix server/_core/index.ts: added app.set('trust proxy', 1) for Railway HTTPS cookie support
- [x] Fix client/src/const.ts: getLoginUrl() now builds real OAuth URL
- [ ] User deploys updated code to Railway (click Publish in Manus UI, then redeploy on Railway)
- [ ] User runs pnpm db:push on Railway to create database tables

## Session 18 — Standalone Auth (Invite Code + Email/Password)
- [x] Add password_hash column to users table
- [x] Add invite_codes table (code, createdBy, usedBy, usedAt, isActive)
- [x] Add auth.register tRPC procedure (requires valid invite code + email + password)
- [x] Add auth.login tRPC procedure (email + password → JWT session cookie)
- [x] Add auth.me procedure (reads session cookie, returns user)
- [x] Add auth.logout procedure (clears session cookie)
- [x] Add admin.createInviteCode procedure (admin only)
- [x] Add admin.listInviteCodes procedure (admin only)
- [x] Add admin.deleteInviteCode procedure (admin only)
- [x] Build Login/Register page (invite code step → email+password step)
- [x] Add Invite Codes tab to Admin panel
- [x] Remove Manus OAuth — context.ts now uses userId-based JWT
- [x] Update getLoginUrl() to point to /login (standalone)
- [x] Run pnpm db:push to apply migration (invite_codes + passwordHash added)
- [x] Admin bootstrap: ADMIN_EMAIL + ADMIN_PASSWORD env vars auto-create admin on startup
- [ ] User sets ADMIN_EMAIL and ADMIN_PASSWORD on Railway and redeploys
- [ ] User logs in at /login with admin credentials
- [ ] User creates invite codes via Admin panel → Invite Codes tab for customers

## Session 19 — Subscription Gate (Invite → Register → Subscribe → Dashboard)
- [x] Build /subscribe page: shows plan details + "Start subscription" button → Stripe checkout
- [x] After registration: redirect to /subscribe instead of /dashboard
- [x] In Dashboard: if subscriptionStatus !== 'active', redirect to /subscribe
- [x] Add /subscribe route to App.tsx
- [x] Stripe success_url redirects to /dashboard, cancel_url to /subscribe
- [x] Admin is exempt from subscription check (role === 'admin' always has access)

## Session 20 — Mixed Visuals Pipeline (Stock + AI Image + AI Image-to-Video)
- [ ] Research Stability AI image-to-video API (Stable Video Diffusion endpoint)
- [ ] Update video generation pipeline: per scene, use a smart mix of stock footage, AI images, and AI image-to-video clips
- [ ] Implement Stability AI image-to-video (SVD) helper: generate image first, then animate it to a short video clip
- [ ] Update fetchSceneVisuals(): rotate between stock (Pexels), AI image (zoompan), and AI image-to-video per scene
- [ ] Ensure fallback chain: AI image-to-video → AI image → Pexels stock → color fallback
- [ ] Update STAGE_LABELS and progress UI to reflect new visual types
- [ ] 0 TypeScript errors, all tests passing

## Session 21 — Documentary Style Upgrade (Johnny Harris / Wendover style)
- [x] Bold text overlays: documentary style with yellow accent line, large 50px bold white text, strong shadow
- [x] Scene badge: yellow background with dark text (documentary style)
- [x] Ken Burns effect on Pexels stock footage clips (zoom-in/out + pan in 4 directions, alternating per scene)
- [x] Warmer color grading: contrast=1.15, saturation=1.28, warm colorbalance (red/orange push)
- [x] Subtitle overlay height increased to 220px for larger text
- [x] 0 TypeScript errors, 10/10 tests passing

## Session 22 — Kinetic Typography
- [x] Add extractKeywords() function: stopword-filtered keyword extraction (no LLM call needed, fast)
- [x] Add renderKineticFrames() function: renders keyword images using canvas (72px bold text, yellow pill for first word, dark pill for rest)
- [x] Integrate kinetic text into composeSceneVideo: overlay keyword images timed across scene duration (y=80, upper-center area, not overlapping subtitle)
- [x] Style: 72px white bold text, yellow highlight pill for first keyword, dark semi-transparent pill for rest
- [x] 0 TypeScript errors, 10/10 tests passing

## Session 22b — Kinetic Typography Visual Improvements (superseded by 22c)
- [x] Improve word selection: reduced to 1 word per scene (most impactful)
- [x] Sparse display: only every 3rd scene, 2s centered in scene
- [x] 0 TypeScript errors, all tests passing

## Session 22c — Kinetic Typography: Sparse & Always-On
- [x] Always show kinetic typography (not gated behind subtitles toggle)
- [x] Only show on every 3rd scene (sceneIndex % 3 === 0) — sparse, not every scene
- [x] Only 1 keyword per scene (the most impactful word), shown in the middle of the scene
- [x] Word appears centered, briefly (2s), then disappears — clean and subtle
- [x] 0 TypeScript errors, 10/10 tests passing

## Session 23 — Fix BUILT_IN_FORGE_API_KEY in Production
- [x] Change ENV from static object (set at module init) to getter function (read at call time) so env vars injected after startup are picked up
- [x] 0 TypeScript errors, 10/10 tests passing

## Session 24 — Fix Voice Preview Error
- [x] Pre-generate example audio for all default voices at server startup (stored in S3) so preview never needs a live Fish Audio call
- [x] Improve error message in client to show the actual server error (not just generic "Could not generate voice preview")
- [x] 0 TypeScript errors, 10/10 tests passing
