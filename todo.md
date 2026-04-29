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
- [ ] Add videoType column to videos table (documentary, listicle, tutorial, explainer)
- [ ] Add scriptApproved column to videos table (0 = pending review, 1 = approved, 2 = rejected)
- [ ] Add customVoiceoverUrl column to videos table (user-uploaded audio)
- [ ] Run pnpm db:push to apply migration

### Script Review Step (like Vidrush)
- [ ] Add video.approveScript tRPC procedure (owner only, sets scriptApproved=1 and triggers pipeline)
- [ ] Add video.rejectScript tRPC procedure (owner only, sets scriptApproved=2 and status=failed)
- [ ] Update video.generate to only generate script + outline, then pause at status="awaiting_approval"
- [ ] Update generateVideoWithAI to be callable separately after approval
- [ ] Add "awaiting_approval" to video status enum in schema
- [ ] Show script review modal in Dashboard when video is in awaiting_approval state
- [ ] Script review modal: show full script with section breakdown, Edit/Approve/Reject buttons

### Video Type Selector
- [ ] Add video type selector to Dashboard generate form (Documentary, Listicle/Top 10, Tutorial, Explainer)
- [ ] Update LLM script generation prompt to use videoType for structure
- [ ] Update admin generate panel to include video type selector

### Custom Voiceover Upload
- [ ] Add voice.uploadCustom tRPC procedure: accepts base64 audio, stores in S3, returns URL
- [ ] Add "Use my own voice" toggle in Dashboard generate form
- [ ] Show file upload input when toggle is on (MP3/WAV, max 50MB)
- [ ] Update video.generate to accept customVoiceoverUrl parameter
- [ ] Update runVideoPipeline to use custom voiceover URL instead of TTS when provided

### Improved Progress UI (Agent-style)
- [ ] Replace generic progress bar with stage-by-stage agent cards in Dashboard
- [ ] Show active agent name: "Researcher", "Scriptwriter", "Voice Engineer", "Visual Director", "Video Editor"
- [ ] Add animated pulse indicator on active stage card
- [ ] Show completed stages with checkmark and elapsed time

### Production Readiness
- [ ] Verify Fish Audio API key is working (test live call from admin voice preview)
- [ ] Verify Pexels API key is working (test search from admin panel)
- [ ] Add retry logic for Fish Audio TTS failures (already has 3 retries, verify)
- [ ] Add health check endpoint: GET /api/health returns Fish Audio + Pexels + DB status

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
