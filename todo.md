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
- [ ] Voice cloning feature (requires ElevenLabs voice clone API)
- [ ] Thumbnail AI generation (can use built-in generateImage — not yet wired)
- [ ] Email notifications on video completion (can use owner notification system)

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
