# FastVid 2.0 — Engineering Specification

**Status:** DRAFT — awaiting approval. No code has been written or modified to produce this document.
**Author:** Chief Software Architect / CTO function, FastVid
**Date:** 2026-08-05
**Predecessor document:** `FastVid-Architecture-Review.md` (the audit of the current system — every design decision below is a direct response to a finding in that review; references are inline as `[Review §X.Y]`)

---

## 0. Vision & Design Principles

FastVid 1.0 proved the product: AI-generated documentary-style videos, real users, real revenue path. It was built the way every successful v1 is built — fast, iteratively, one fix at a time. The architecture review found the natural consequence of that: a 25,000-line rendering file, a single global concurrency limiter capping the whole platform near one video at a time, globally-shared AI quotas, and several security gaps that are cheap to fix but were never prioritized under feature pressure.

FastVid 2.0 is not a rewrite of the product — the documentary-style scripting, the voice pipeline, the archive-footage sourcing, the compose logic — all of that is *earned knowledge* and stays. FastVid 2.0 is a redesign of the **architecture underneath** that product, so that:

1. **A render job is a portable, stateless unit of work** — it can run on any worker, be retried on any worker, and be scaled by adding workers, not by tuning a shared in-process number.
2. **Every AI decision is inspectable and replayable** — the system produces an explicit "Edit Decision List" before it renders anything, not a black box that happens to produce a video.
3. **Adding capability never means touching the core** — a new media source, a new visual effect, a new video style is a plugin/config addition, not a pipeline rewrite.
4. **Cost and quota are per-user, not global** — one customer's usage can never degrade another's.
5. **The platform is boring where it should be boring** (queue, storage, deploy, observability — proven, off-the-shelf patterns) and **interesting where it should be interesting** (the AI Director, the Visual Intelligence Engine, the Cinematic Editing Engine — where FastVid actually competes with Vidrush/InVideo AI/Pictory).

Everything below is designed against three concrete scale targets, not vague aspirations:

| Target | Definition |
|---|---|
| **Thousands of users** | Tens of thousands of registered accounts; hundreds of daily active users generating videos |
| **Hundreds of concurrent renders** | 100-300 videos actively rendering at the same moment, platform-wide |
| **Horizontal scaling** | Going from 2 workers to 100+ workers requires a replica-count change in the deployment config — zero code changes, zero manual re-tuning |

---

## 1. Overall System Architecture

FastVid 2.0 is a **modular monolith core with a horizontally-scaled stateless worker fleet** — not a full microservices rewrite. Full microservices would trade the current review's problems for a distributed-systems-complexity problem this team doesn't need yet. The right unit of independent scaling is the **render worker**, because that's the one component whose resource needs (CPU, memory, ffmpeg processes) are wildly different from the API's, and the one thing that must scale from 2 to 100+ instances. Everything else scales in a much smaller range and doesn't need its own deployment lifecycle yet.

```
                                   ┌─────────────────────┐
                                   │   Cloudflare CDN     │  ← serves final videos, static assets
                                   └──────────┬───────────┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     │                        │                        │
              ┌──────▼──────┐         ┌───────▼────────┐        ┌─────▼──────┐
              │  Web Client  │         │   API Service    │        │  Admin UI   │
              │  (React SPA) │◄───────►│  (stateless,      │◄──────►│ (same SPA,  │
              └─────────────┘  tRPC +  │   N replicas)     │  tRPC  │  gated)     │
                               REST v1  └───────┬──────────┘        └────────────┘
                               + WS/SSE          │
                                    ┌────────────┼────────────────────┐
                                    │            │                    │
                             ┌──────▼─────┐ ┌────▼─────┐      ┌───────▼────────┐
                             │   MySQL     │ │  Redis    │      │ Object Storage │
                             │ (source of  │ │ (queue +  │      │  (R2 / B2 / S3)│
                             │  truth)     │ │  cache +  │      └────────────────┘
                             └─────────────┘ │  pub/sub) │
                                              └────┬──────┘
                                                   │  BullMQ jobs
                        ┌──────────────────────────┼──────────────────────────┐
                        │                          │                          │
                 ┌──────▼──────┐           ┌───────▼──────┐           ┌──────▼───────┐
                 │  Worker #1   │           │  Worker #2    │   ...     │  Worker #N    │
                 │ (stateless,  │           │ (stateless,   │           │ (stateless,   │
                 │  1 job at a  │           │  1 job at a   │           │  1 job at a   │
                 │  time)       │           │  time)        │           │  time)        │
                 └──────┬───────┘           └───────┬───────┘           └───────┬──────┘
                        │                            │                          │
                        └──────────────┬─────────────┴──────────────────────────┘
                                       │
                          ┌────────────▼─────────────┐
                          │   AI Gateway (library,     │
                          │   used by both API and      │
                          │   Worker processes)          │
                          │  → Gemini / Groq / OpenAI /  │
                          │    future providers           │
                          └───────────────────────────────┘
```

**Key architectural shift from v1:** in v1, "the worker" is a single Railway service running one Node process with a hard-coded global ffmpeg semaphore [Review §4.2, §6.1]. In v2, **"a worker" is a replica**, and there can be 2 or 200 of them; each replica has its *own* small, locally-scoped concurrency limit (e.g., 1 render at a time, tuned to its own container's resources), and the *number of replicas* — not a shared in-process counter — is the scaling lever. This single change is what turns "the whole platform renders ~1 video at a time" into "the platform renders as many videos at a time as you're willing to pay workers for."

---

## 2. Folder Structure

The 25,358-line `videoPipeline.ts` [Review §2.1, §6.1] is the single biggest velocity and safety risk in the current codebase — even a well-scoped, well-researched change (the chunking work done this session) required extensive investigation just to safely map one function's control flow. FastVid 2.0 restructures around **pipeline stages as independently testable modules**, using a monorepo layout (npm/pnpm workspaces — no new tooling beyond what's already in use):

```
fastvid/
├── apps/
│   ├── web/                     # API service — tRPC + REST v1 + WS, auth, billing, admin
│   │   ├── src/
│   │   │   ├── routers/         # one file per domain: video.ts, auth.ts, billing.ts, admin.ts, media.ts
│   │   │   ├── rest/            # versioned REST endpoints for programmatic/enterprise access
│   │   │   ├── ws/              # WebSocket/SSE progress broadcasting
│   │   │   └── server.ts
│   │   └── Dockerfile
│   │
│   └── worker/                  # Render worker — thin entrypoint only
│       ├── src/
│       │   ├── main.ts          # boot, health endpoint, queue consumer registration
│       │   └── executeJob.ts    # pulls a job, runs the pipeline, reports progress
│       └── Dockerfile
│
├── packages/
│   ├── core/                    # shared types, config, logging, error taxonomy
│   ├── db/                      # Drizzle schema, migrations, query modules (by domain, not one 1500-line file)
│   │   ├── schema/
│   │   │   ├── users.ts  billing.ts  videos.ts  mediaArchive.ts  traces.ts  ...
│   │   └── migrations/
│   │
│   ├── pipeline/                 # THE replacement for videoPipeline.ts — one stage per module
│   │   ├── stages/
│   │   │   ├── 01-script/
│   │   │   ├── 02-voiceover/
│   │   │   ├── 03-visual-intelligence/   # search + select, see §17
│   │   │   ├── 04-ai-director/           # produces the Edit Decision List, see §18
│   │   │   ├── 05-cinematic-render/      # executes the EDL, see §17 Cinematic Editing Engine
│   │   │   └── 06-finalize/              # music mix, export, upload
│   │   ├── PipelineRunner.ts     # orchestrates stages, handles chunking (already built this
│   │   │                         # session), checkpointing, resumability
│   │   └── types.ts              # the stage-to-stage contract (PipelineState)
│   │
│   ├── ai-gateway/               # LLM provider abstraction (formalizes today's env.ts/llm.ts)
│   │   ├── providers/            # gemini.ts groq.ts openai.ts ... one file per provider
│   │   ├── budget/                # PER-USER quota/budget accounting (see §12)
│   │   └── cache/                 # response caching
│   │
│   ├── media-providers/           # the plugin framework, see §21
│   │   ├── ProviderInterface.ts
│   │   ├── ProviderRegistry.ts
│   │   ├── resilience/            # shared circuit-breaker/retry/rate-limit, used by every plugin
│   │   └── plugins/
│   │       ├── pexels/  pixabay/  wikimedia/  openverse/  internet-archive/
│   │       ├── europeana/  curated-archive/  user-uploads/
│   │
│   ├── cinematic-engine/          # the effects library, see §17
│   │   ├── effects/                # one file per effect: ken-burns.ts, glow.ts, particles.ts, ...
│   │   ├── transitions/
│   │   ├── captions/
│   │   └── EffectRegistry.ts
│   │
│   ├── templates/                  # the Template Engine, see §22
│   │   └── definitions/            # documentary.ts, viral.ts, news.ts, ...
│   │
│   ├── storage/                    # object storage abstraction (R2/B2/S3), see §9
│   ├── queue/                      # BullMQ wrapper, job type definitions, see §7
│   └── observability/              # structured logging, metrics, tracing helpers, see §14-15
│
├── client/                          # React SPA — same structure as today, with code-splitting fixes
├── infra/
│   ├── docker/                      # shared base images (ffmpeg, CLIP model layer)
│   ├── ci/                          # GitHub Actions workflows
│   └── northflank/                  # deployment manifests (see §9 Deployment)
├── docs/
│   ├── FASTVID_ENGINEERING_SPECIFICATION.md   # this document
│   └── architecture-review/
└── package.json                      # workspace root
```

**Why this specific split:** every top-level `packages/*` directory is something that gets used by *both* `apps/web` and `apps/worker` (AI gateway, media providers, DB) — or is purely `apps/worker`'s concern (pipeline, cinematic-engine). Nothing in `packages/` imports from `apps/`. This one rule, enforced by lint (`eslint-plugin-boundaries` or equivalent), is what prevents the "everything is 200 flat files that all import each other" problem from recurring [Review §2.1].

---

## 3. Service Architecture

| Service | Replicas | Statefulness | Scales with |
|---|---|---|---|
| **API (`apps/web`)** | 2+ (min 2 for zero-downtime deploys) | Stateless (session in JWT cookie + Redis-backed rate-limit state) | Request volume |
| **Worker (`apps/worker`)** | 2 → 100+ | **Fully stateless** — pulls one job, does it, reports result, asks for the next | Queue depth (autoscaled) |
| **Scheduler** | 1 (leader-elected if 2 for HA) | Stateless, runs cron-style jobs (trace-table retention, stale-job sweeps, quota resets) | Fixed, tiny |
| **Redis** | Managed (Northflank add-on or Upstash) | Stateful — queue + cache + rate-limit counters + pub/sub for WS fan-out | Memory/throughput |
| **MySQL** | Managed (PlanetScale / Northflank managed MySQL) | Stateful — source of truth | Read replica once needed |
| **Object storage** | R2 (primary) | Stateful — all media | Unbounded (managed by provider) |

**Statelessness is the whole point of the worker redesign.** A v1 worker holds a `renderCtx` object, a `visualDedup` state object, and a live `ffmpegSemaphore` slot for the entire 10-30 minute life of a render, all in the memory of one specific process [Review §6.1, §4.2]. If that process dies, the job dies with it and the user waits out a stall-detection window of tens of minutes [Review §2.6]. A v2 worker:

1. Pulls exactly one job from the BullMQ queue.
2. Reconstructs everything it needs for that job from the DB + object storage (nothing lives only in this process's memory that isn't also checkpointed).
3. Runs the pipeline, checkpointing progress after each stage (and after each chunk within the render stage — the chunking logic built this session is the checkpoint boundary).
4. If it crashes mid-job, BullMQ's built-in stalled-job detection (seconds, not tens of minutes) re-queues the job; the next worker to pick it up resumes from the last completed checkpoint instead of starting over.
5. Reports "I'm free" and pulls the next job.

This directly replaces the "1-2 concurrent renders, platform-wide" ceiling [Review §4.2] with "however many workers you run × their own local capacity."

---

## 4. API Architecture

**Two API surfaces, one backend:**

1. **tRPC** (kept — it's a strength of the current system, fully type-safe, works great for the React SPA). All existing `video.*`, `auth.*`, `admin.*`, `billing.*` procedures migrate over largely as-is, minus the fixes in §11.
2. **REST v1** (new — `/api/v1/...`, OpenAPI-documented) — required for "future enterprise customers": tRPC's tight client/server coupling doesn't serve third-party integrators. REST v1 covers the subset enterprise customers actually need: create a video, check status, retrieve the result, manage API keys. Generated from the same underlying service layer as the tRPC procedures (both call into shared `packages/core` business-logic functions — no logic duplicated between the two surfaces).

**Real-time progress replaces polling.** V1 polls `video.list` every 5 seconds for the whole time the dashboard is open, and polls `video.pollStatus` every 5 seconds per in-progress video card [Review §3.3] — load that scales linearly with concurrent users. V2 workers publish progress events to a Redis pub/sub channel keyed by `videoId`; the API service subscribes and fans out to connected clients via WebSocket (SSE as a fallback for restrictive networks). No client polls anything while idle; a video card subscribes only while its video is actually rendering.

**API key system** for enterprise/programmatic access: scoped keys (read-only vs. can-generate), per-key rate limits, separate from cookie-session auth, stored hashed (never plaintext) with a prefix for identification in logs (`fv_live_...`).

**Rate limiting**: token-bucket in Redis, applied per-user and per-IP, shared correctly across all API replicas (a v1-style in-process limiter would silently become "N independent limiters" once horizontally scaled [Review §4.2 note on `userRenderLocks`] — this is explicitly designed to be replica-count-agnostic from day one).

---

## 5. AI Architecture

The AI layer has three distinct responsibilities that v1 blends together inside `videoPipeline.ts` and ~30 scattered call sites [Review §5.1]. V2 separates them cleanly:

1. **Script Generation** — turns a user prompt into narration text. Unchanged in spirit from today's `scriptEngine.ts` approach (parallel per-scene narration calls); moves into `packages/pipeline/stages/01-script`.
2. **Visual Intelligence** — understands *what the narration is about* well enough to find the right footage. New, formalized subsystem — see §17.
3. **AI Director** — decides *how the video should look and feel*: pacing, transitions, camera movement, caption timing. New subsystem — see §18. This is genuinely new capability, not present in v1.

All three call into one shared **AI Gateway** (`packages/ai-gateway`) instead of each of ~30 call sites independently choosing a provider [Review §5.1]:

- **Provider registry**: Gemini, Groq, OpenAI today; adding a provider is a new file implementing one interface, not touching call sites.
- **No more scattered `preferProvider: "groq"` overrides** [Review §5.1] — call sites specify *intent* (`{ tier: "fast" }` vs `{ tier: "quality" }`), and the gateway resolves intent → provider using the current fallback-chain logic, centrally, once.
- **Per-user budget/quota**, not global [Review §5.1, §1.6, §12] — the single most important AI-layer change for multi-tenant scale. Every plan tier (free/pro/enterprise) gets its own daily token/request/dollar allowance, tracked per user in Redis (fast path) + MySQL (durable), so one heavy user's usage can never exhaust another user's ability to generate a video.
- **Response caching**: exact-prompt and semantic-similarity caching (embedding-based) for cacheable call types (tagging, classification, editorial review) — formalizes and extends the beat semantic-profile cache already built this session.
- **Prompt registry**: every prompt template is versioned; every AI Gateway call logs which prompt version + provider + model produced which output, against which job. This is what makes a bad output *debuggable* six weeks later instead of "the LLM did something weird once."

---

## 6. Rendering Architecture

The rendering pipeline becomes an explicit **stage pipeline with a typed contract between stages**, replacing the current single giant function [Review §2.1, §6.1]:

```
Script → Voiceover → Visual Intelligence → AI Director → Cinematic Render → Finalize
```

Each stage:
- Reads a `PipelineState` object (produced by the previous stage, persisted to MySQL + object storage — not just held in worker memory).
- Does its one job.
- Writes an updated `PipelineState`, checkpointed durably.
- Can be **retried in isolation** — a Cinematic Render failure doesn't force re-running Script/Voiceover/Visual Intelligence/AI Director, because their outputs are already checkpointed. This directly solves the "any failure redoes the whole video" problem that made long videos so fragile in v1 (the exact problem the chunking work this session partially addressed for one stage — v2 generalizes checkpointing to every stage).

**The AI Director's output (the Edit Decision List, §18) is the hard boundary between "creative decision" and "mechanical execution."** Everything after the EDL is produced is deterministic ffmpeg work with zero LLM calls — meaning a render can be *re-executed* (e.g., after a crash, or to regenerate at higher quality) without spending any AI budget or re-making any creative decisions, just replaying the same EDL.

**Chunked processing** (built this session, kept and generalized): the Cinematic Render stage processes scenes in ~60-second batches sequentially rather than firing the whole video's scenes at once, so a 1-minute video and a 20-minute video place the same *peak* load on a worker — only the *number of chunks* differs, not the concurrency.

---

## 7. Queue Architecture

**Replace DB-polling with Redis + BullMQ.** The current queue is a reasonably well-built DB-polling system (the claim logic is correctly atomic, verified in the review [Review §2.6, §4.2]) but it doesn't scale cleanly: every worker replica independently re-scans the same top-100 queued rows on every poll tick, there's no dead-letter queue, and crash recovery takes tens of minutes.

**Job types:**
| Queue | Purpose | Priority levels |
|---|---|---|
| `script-generation` | Fast, cheap, can run on the API service or a worker | Normal |
| `render` | The full pipeline — the expensive, long-running job | Free / Pro / Enterprise (enterprise jobs preempt free-tier queue position) |
| `post-process` | Re-render for edits, thumbnail regeneration, exports | Normal |

**Per job:** exponential-backoff retries (bounded, e.g. 3 attempts), then dead-letter queue with structured failure metadata (replacing v1's free-text `errorMessage` on the video row [Review §2.6]) — queryable for "show me every render that failed at the Visual Intelligence stage this week," not just a text search.

**Fast failure detection**: BullMQ's stalled-job detection (heartbeat-based, tens of seconds) replaces the 90-second-interval DB staleness sweep [Review §2.6] as the primary crash-recovery mechanism; the DB sweep becomes a slow-path backstop, not the main recovery path.

**Autoscaling signal**: queue depth (jobs waiting + estimated time to drain) drives worker replica count on the deployment platform — this is what makes "2 workers to 100+ workers, zero code change" concrete: it's a Northflank/container-platform autoscaling rule reading a metric the queue already exposes, not an application-level decision.

---

## 8. Storage Architecture

**Object storage becomes the only place a rendered video, an archive clip, or a user upload permanently lives.** Local disk is scratch space only — used during a render for intermediate ffmpeg I/O, then discarded; nothing durable ever depends on a specific worker's local disk existing tomorrow [Review §4.3: v1's "ephemeral local disk = videos lost on redeploy" risk is eliminated by design, not by hoping the volume mount stays attached].

**Provider**: Cloudflare R2 as primary (S3-compatible API, zero egress fees when paired with Cloudflare's CDN — a direct, structural cost win over v1's storage/bandwidth model). Backblaze B2 or any S3-compatible store supported as a drop-in alternative through the same abstraction (`packages/storage`), so there's no vendor lock-in and no code change to switch.

**Key namespace:**
```
final/{userId}/{videoId}/output.mp4              # user-facing finished videos
final/{userId}/{videoId}/thumbnail.jpg
scratch/{videoId}/scenes/{chunkIndex}/{sceneIndex}.mp4   # intermediate — TTL'd, auto-deleted
archive/{provider}/{assetId}/{quality}.mp4        # curated/cached third-party footage
uploads/{userId}/{uploadId}.*                      # user-provided assets (voiceover, images)
```

**Lifecycle policies** (bucket-level, no application code needed): `scratch/*` auto-expires after 24-48 hours (covers retry windows without leaking storage cost forever); `archive/*` has no TTL (it's a shared cache across all users' renders, intentionally durable); `final/*` retention follows the user's plan tier.

**CDN**: Cloudflare sits in front of the bucket for all `final/*` and `archive/*` reads — video playback and download no longer transit the API service's own process at all [Review §4.3 finding that v1 proxies local-disk video playback through the web process].

---

## 9. Deployment Architecture

**Target platform: a container-native platform (Northflank primary candidate; the design is platform-agnostic via standard Docker + a declarative service manifest, so Fly.io/Render/Google Cloud Run are equally viable without redesign).** This directly addresses the review's core Railway-specific finding: the `pids.max` container ceiling Railway confirmed it cannot raise [Review §4.2] is a *platform* constraint, and the fix is a platform with per-service resource controls the team can actually tune, not a code workaround.

**Docker**: multi-stage build (builder stage with the full toolchain → slim runtime stage with only production deps + ffmpeg + the CLIP model runtime) [Review §4.1], plus a `.dockerignore` [Review §4.1] so the build context isn't the whole repo history and debug-script clutter. One shared base image (with ffmpeg + native deps pre-baked) is used by both `apps/web` and `apps/worker` Dockerfiles to avoid duplicating that layer.

**CI/CD (GitHub Actions)** — the review found *zero* automated gate exists today [Review §4.4]; this is one of the highest-leverage, lowest-cost fixes in the whole roadmap:
1. On every PR: `tsc --noEmit`, `vitest run`, `prettier --check`, Docker build (no push).
2. On merge to `main`: build + push versioned images, deploy to a staging environment, run a smoke test (generate a real 1-minute video end-to-end), then require manual promote-to-production (or automatic, once smoke tests are trusted).
3. Database migrations run as a separate, explicit CI step (Drizzle migrate) before the new API/worker images roll out — never implicitly on app boot.

**Environments**: `staging` and `production` as fully separate deployments (separate DB, separate Redis, separate storage bucket) — v1 has no staging environment at all today, meaning every change (including this session's chunking refactor) goes straight to production with no automated or environment-level safety net beyond manual testing.

**Rollout strategy**: rolling deploys for the API service (always ≥1 replica healthy); workers drain in-flight jobs before terminating (BullMQ supports graceful shutdown — a worker stops accepting new jobs, finishes its current one, then exits) rather than being killed mid-render.

---

## 10. Database Architecture

MySQL + Drizzle stays — it works, and the review found no reason to change engines, only how it's used [Review §2.3, §2.5].

**Fixes, not a rewrite:**
- Every index applied via a raw-SQL migration gets reflected back into the Drizzle `schema.ts` definitions, so `schema.ts` is always the accurate source of truth [Review §2.3].
- `videos.metadata`/`progressLog`/`videoScenes` JSON blobs: fields that need to be *queried or filtered* (not just stored and displayed) move to real relational tables. `progressLog` becomes a proper `pipeline_stage_events` table (one row per stage transition, per job) — this is also exactly the durable checkpoint state the stateless-worker redesign (§3) needs to exist anyway, so this isn't extra work, it's the same table serving two purposes.
- **Retention jobs, actually built** (not just documented as intended [Review §2.3]): the Scheduler service (§3) runs nightly jobs deleting expired `scene_candidate_cache` rows and archiving/pruning `beat_selection_traces`/`pipeline_run_traces` past a configurable age.
- **Connection pool sized to reality**: `connectionLimit` becomes an env-configurable value with a documented formula (`managed_db_max_connections / (expected_max_replicas × services)`), not a hardcoded `15` per process regardless of replica count [Review §2.5].
- **Query timeouts** added at the pool level so one slow/unbounded query can't hold a connection indefinitely [Review §2.5].
- **Read replica** introduced once admin/analytics read load is measurably competing with the write-heavy render path — not needed on day one, called out explicitly as a Phase 3 item (§26).

---

## 11. Security Architecture

Every finding from the review's security section is addressed here as a concrete design decision, not deferred [Review Part 1 in full]:

| Finding | v2 Design |
|---|---|
| Hardcoded JWT fallback secret | Boot-time hard failure if `JWT_SECRET` is unset — no fallback string exists in code at all |
| `passwordHash` returned to client | All user-facing API responses use an explicit output DTO/Zod `.output()` schema that never includes `passwordHash`; enforced by a lint rule that flags any `users.*` select without an explicit column list in a client-facing path |
| No auth rate limiting | Redis-backed token-bucket rate limiting on login/register/reset endpoints, part of the shared API rate-limit middleware (§4) |
| `Math.random()` for tokens | All security-sensitive tokens (password reset, invite codes, API keys) use `crypto.randomBytes` exclusively; a lint rule bans `Math.random()` outside clearly-marked non-security code |
| bcrypt hash exposure risk in general | Reinforced by never selecting `passwordHash` in any query that isn't the login/register comparison path itself |
| `/api/internal/*` default key | Internal trigger routes require mTLS or a network-level restriction (private networking between API and worker, which Northflank/most container platforms provide natively) *in addition to* a required (boot-fails-if-unset) internal key — defense in depth instead of one guessable string |
| Stripe webhook unverified fallback | Fallback path removed entirely; missing signature/secret is a hard 400, no environment-based "dev mode" branch in the production code path |
| Command injection in one ffmpeg fallback | The Cinematic Editing Engine's effect modules (§17) all take structured parameters, never raw interpolated strings — ffmpeg commands are built via a single sanitizing command-builder used by every effect, not hand-rolled per module |
| Password reset tokens in-memory only | Stored in MySQL (`password_reset_tokens`, already exists in schema, just needs to actually be used) — durable across restarts and replica-agnostic |
| `/local-storage/` unauthenticated route | Eliminated by design — there is no local-storage serving path in v2 (§8); everything is served via signed, expiring object-storage URLs or the CDN |
| Global LLM budget cap | Per-user budgets (§5, §12) |
| No general rate limiting / no security headers | `helmet`-equivalent middleware applied platform-wide; general per-IP rate limiting on top of per-user limiting |

**New in v2**: an audit log for every admin action (role changes, subscription overrides, video deletions) — a `admin_audit_log` table, written to on every `adminProcedure` mutation via shared middleware, not opt-in per procedure.

---

## 12. Scalability Strategy

This is the synthesis of everything above into one statement: **v1's ceiling was a single shared in-process constant (the ffmpeg semaphore) and a single shared global budget (LLM spend cap) [Review Executive Summary]. Every part of v2's design either removes a shared bottleneck or turns it into a per-user allocation:**

| Bottleneck removed | How |
|---|---|
| Global ffmpeg semaphore (~1-2 concurrent renders, platform-wide) | Stateless workers, each with a small *local* concurrency limit; scaling = adding worker replicas |
| Global LLM daily budget | Per-user budget/quota in the AI Gateway (§5) |
| Global free-tier quota exhaustion | Per-user allocation against each provider's free tier, with automatic fallback to paid once a *user's* (not the platform's) allowance is spent |
| DB-polling queue re-scanning on every tick, every replica | Redis/BullMQ push-based dispatch |
| 15-connection-per-process hardcoded DB pool | Formula-driven pool size, read replica once needed |
| Single point of video-serving load on the API process | CDN + object storage direct serving |
| One giant file blocking safe, fast changes | Stage-pipeline architecture — each stage independently modifiable and testable |

**Concrete scaling math**: if one worker replica safely sustains 1 concurrent render (a conservative, container-tunable number), "hundreds of concurrent renders" is a matter of running hundreds of worker replicas — which is exactly what container-platform autoscaling is for, driven by queue depth (§7). This is the difference between "we need a fundamentally different architecture to scale" (v1's actual situation) and "we need to turn a dial" (v2's situation).

---

## 13. Cost Optimization Strategy

- **Per-user AI budgets** (§5, §11) prevent both runaway cost from one user *and* make cost predictable per plan tier — a Pro plan can carry a defined LLM cost ceiling that maps directly to its price.
- **Tiered model usage**: cheap/fast models (Groq, Gemini Flash) for high-volume simple tasks (tagging, entity extraction, classification); premium models reserved for the AI Director's final creative decisions and script quality passes, where output quality actually matters to the end product.
- **Aggressive caching** at the AI Gateway (§5) and media-search layer — a repeated or highly similar query never re-pays the LLM/search cost.
- **Autoscale workers toward zero during low-traffic hours** (container platforms support scale-to-zero or a low min-replica floor) instead of paying for idle worker capacity 24/7, which v1's single always-on worker service does today by construction.
- **Zero-egress storage**: R2 + Cloudflare CDN eliminates the bandwidth cost line item that scales with video views/downloads — this compounds as the user base grows, unlike a flat-fee storage choice.
- **Lifecycle-managed scratch storage** (§8) prevents intermediate render artifacts from silently becoming a growing storage bill.
- **Free third-party media source rotation**: the Media Provider Framework (§21) makes it trivial to route a given search across multiple free sources by *quota remaining*, not just a fixed priority order — squeezing more free-tier usage out of Pexels/Pixabay/Wikimedia/etc. before ever needing a paid stock source.

---

## 14. Monitoring Strategy

- **Metrics**: Prometheus-compatible metrics exported from every service (API, worker, scheduler) — queue depth, worker utilization, render success/failure rate by stage, per-stage timing (extends the render-budget tracker already built this session into a real, queryable metric instead of console-log-only), DB pool saturation, AI Gateway spend rate per plan tier. Grafana dashboards (self-hostable, or a managed equivalent) on top.
- **SLOs, defined explicitly** (not vibes):
  - Render success rate ≥ 97% (excluding user-cancelled jobs)
  - p95 render time within a defined multiple of video length (e.g., ≤ 3× the video's runtime)
  - Queue wait time p95 < 2 minutes at target load
  - API p95 latency < 300ms for non-render endpoints
- **Alerting** on: queue backlog growing faster than it's draining, any worker crash-looping, memory pressure on a worker (the guard that doesn't exist in v1 today [Review §4.2, §6.2] becomes both a safety mechanism *and* a metric/alert source in v2), a user/plan-tier approaching its AI budget ceiling, Stripe webhook failures.

---

## 15. Logging Strategy

- **Structured JSON logging everywhere**, replacing today's ad hoc `console.log`/`console.warn` string interpolation [implicit throughout the review and this session's own log-reading work]. Every log line carries a consistent shape: `{timestamp, level, service, videoId?, jobId?, traceId, message, ...context}`.
- **A trace ID per render job, threaded through every stage.** This is the single most valuable logging change for day-to-day operability: this session spent real, repeated effort manually correlating Railway log excerpts to figure out which lines belonged to which video and which pipeline stage. In v2, `grep traceId` (or a log platform's equivalent filter) instantly produces the complete story of one render, script-generation through finalize, across every service and worker replica it touched.
- **Log levels used with actual meaning**: `debug` (dev only), `info` (stage transitions, job lifecycle), `warn` (recovered failures, fallbacks triggered), `error` (unrecovered failures). No sensitive data (API keys, full user PII, password hashes) ever enters a log line — enforced by a shared logger wrapper that redacts known-sensitive field names automatically.
- **Centralized aggregation**: ship to a log platform (Northflank's built-in log viewer at minimum; Axiom/Better Stack/Loki for longer retention and real querying) rather than relying on ad hoc log-file exports the way this session's debugging did.

---

## 16. Future Roadmap

**This section sequences the whole document — see Part IV below for the phased implementation plan.** In summary, ordered by dependency (each phase's foundation is required by the next):

1. **Foundation** (queue, storage, worker statelessness, security fixes, CI/CD) — nothing else in this document is safely buildable without this.
2. **Pipeline restructure** (split `videoPipeline.ts` into the stage architecture) — required before the AI Director and Visual Intelligence Engine can be built cleanly.
3. **Intelligence layer** (Visual Intelligence Engine, AI Director, Media Provider Framework, Cinematic Editing Engine, Template Engine) — the actual product differentiation against Vidrush/InVideo AI/Pictory.
4. **Enterprise & scale** (REST v1 API, API keys, team accounts, read replicas, multi-region rendering, white-label).

Longer-term, beyond this document's immediate scope: GPU-accelerated rendering for effects that benefit from it, real-time collaborative script editing, a mobile companion app, and a marketplace for community-contributed Templates and Media Provider plugins — noted here as directional, not designed in detail, since they depend on where the product goes after 2.0 ships.

---

# Part II — The Intelligence Layer

## 17. Visual Intelligence Engine

**Problem it solves**: v1's visual search is fundamentally keyword-based — a beat's text produces one or a few literal search queries, sent to whichever media source is up next in a fixed priority order [Review §5.2, §6.1 media-source duplication finding]. This is exactly the mechanism the user has explicitly asked to move beyond.

**Design — a dedicated pipeline stage, `packages/pipeline/stages/03-visual-intelligence`, with four sub-steps per beat:**

### 17.1 Entity & Meaning Extraction
For every beat/sentence, one structured-output LLM call (via the AI Gateway, cached — many beats across many videos share entities) extracts:
```ts
type BeatIntelligence = {
  people: { name: string; role?: string }[];
  companies: string[];
  locations: { name: string; specificity: "city"|"region"|"country" }[];
  events: string[];
  dates: { text: string; normalized?: string }[];   // "the 1990s" → normalized range
  emotions: string[];                                // e.g. ["tension", "triumph"]
  objects: string[];                                 // concrete visual nouns
  abstractConcept?: string;                          // when the sentence is non-visual
                                                       // ("the economy collapsed") — flags
                                                       // that a metaphorical strategy is needed
};
```
This directly replaces ad hoc, single-purpose extraction scattered across today's codebase (person/topic locking, geo-tag extraction, etc. [Review §5.2]) with one consistent, reusable structure every downstream step consumes.

### 17.2 Multi-Strategy Search Generation
From one `BeatIntelligence`, generate **several distinct search strategies**, not one query:
- **Literal**: the concrete objects/people/locations named.
- **Entity-specific**: named-entity search against sources that support it well (Wikimedia Commons for a named person/event, curated archive for era-specific footage).
- **Metaphorical/visual-equivalent**: when `abstractConcept` is set — "the economy collapsed" → visual strategies like "empty factory," "stock ticker falling," "closed storefront." (V1 already has an early version of this — the "fallback" queries in `visualIntentExtractor.ts` [Review §5.2] — v2 promotes this from a fallback into a first-class, always-generated strategy.)
- **Emotional-tone**: informed by the `emotions` field, biasing style/mood of candidate footage independent of literal subject match.

Each strategy is dispatched, in parallel, across the Media Provider Framework (§21) — every registered provider that's relevant to the strategy type gets queried.

### 17.3 Semantic Ranking
Candidates from every strategy/provider are pooled and ranked by:
1. **Semantic similarity** — embed the beat's full intent (not just keywords) and each candidate's title/tags/description, rank by cosine similarity (extends and formalizes the semantic-visual-matching work already present in v1).
2. **Quality signals** — resolution, aspect ratio fit, source license class, source reliability (a provider's historical hit-rate feeds back into its ranking weight over time).
3. **Diversity** — the existing cross-scene dedup logic (`visualDedup`, correctly identified in the review as legitimately whole-video state [Review §6.1]) is preserved as-is architecturally — it's a genuinely good pattern, just needs to keep working the same way inside the new stage structure.

### 17.4 The "Never Settle" Rule
A minimum semantic-relevance score is required for a candidate to be accepted. Below that threshold, the engine does **not** fall back to a weak keyword match — it escalates to AI-generated imagery (already present in v1 as a fallback tier) or a template-driven text/graphic treatment, with the threshold and escalation path defined per Template (§22, e.g. a "Minimal" template may accept graphic/text treatments readily; a "Documentary" template biases hard toward archival footage). This formalizes v1's already-good instinct (the "guaranteed fallback ladder") into an explicit, tunable decision rule instead of implicit code-path behavior.

---

## 18. AI Director

**Problem it solves**: v1 has no single "director" — pacing, camera movement, transition choice, and caption timing are each decided by scattered, independent pieces of logic (editorial reorder, shot-sequence optimizer, visual rhythm engine, etc. [Review §5.2, §6.1]) with no unifying creative model. The user's explicit ask — "the AI should think like a professional documentary editor" — requires one coherent decision-maker, not more independent heuristics.

**Design**: the AI Director is a pipeline stage that runs *after* Visual Intelligence and *before* Cinematic Render. It consumes:
- The full script + per-beat `BeatIntelligence`
- The ranked visual candidates for every beat
- The active Template (§22) — style/pacing/mood rules
- Voiceover timing (exact word/beat timestamps, already available from the alignment work in v1)

...and produces one artifact: the **Edit Decision List (EDL)**.

```ts
type EditDecisionList = {
  videoId: string;
  scenes: SceneDecision[];
};

type SceneDecision = {
  sceneIndex: number;
  beats: BeatDecision[];
  transitionIn: TransitionType;    // e.g. "flash", "blur", "hard-cut"
  transitionOut: TransitionType;
};

type BeatDecision = {
  clipRef: MediaCandidateRef;       // which asset, from Visual Intelligence's ranked output
  inPoint: number; outPoint: number;
  cameraMovement: "ken-burns-in" | "ken-burns-out" | "pan-left" | "static" | ...;
  captionStyle: CaptionStyleRef;    // from the active Template
  captionTimingMs: [number, number];
  emphasis?: "zoom-punch" | "flash-cut" | "slow-motion" | null;
  soundEffectCue?: string;          // e.g. "whoosh-transition", "impact-hit"
  pacingMs: number;                  // shot duration — the Director's core "editing rhythm" decision
};
```

**Why an explicit EDL, not "the AI renders it directly":**
1. **Inspectable** — a support engineer (or the user, eventually, via an editor UI) can look at exactly why a shot is 2.4 seconds long or why a flash transition was chosen, instead of it being buried in a black-box render.
2. **Replayable** — re-rendering (after a crash, or for a quality bump) replays the same EDL with zero additional LLM calls and zero risk of a re-run producing a *different* creative result than the first attempt.
3. **Testable** — the AI Director's output is a data structure; it can be unit-tested against golden EDLs for known inputs, something that's essentially impossible to do against "the whole render pipeline produced approximately the right video."
4. **A natural foundation for a future manual-editing UI** — if FastVid ever lets a user tweak an AI-generated edit, they're editing the EDL, not fighting the render pipeline directly.

The AI Director's actual decision-making combines a **rules engine** (deterministic, Template-driven defaults — e.g., "Viral" template biases toward fast pacing and flash transitions; "Documentary" biases toward slower Ken Burns and hard cuts) with **targeted LLM calls** for genuinely creative judgment calls (e.g., "does this specific beat deserve an emphasis moment," "is this transition point a natural scene break or mid-thought"). This keeps AI cost proportional to actual creative complexity instead of one large opaque call trying to decide everything at once.

---

# Part III — The Rendering Pipeline

## 19. Cinematic Editing Engine

**Problem it solves**: v1's visual effects are implemented ad hoc, scattered across `cinematicEffectsEngine.ts`, `motionGraphicsLayer.ts`, and inline in `videoPipeline.ts` itself, with real duplicated code between them (`ensureEvenDim()` copy-pasted three times [Review §2.2]) and inconsistent ffmpeg command sanitization (the one command-injection gap found in the review [Review §1.5] is a direct symptom of this — one effect module didn't reuse the shared sanitizer because there wasn't a single, mandatory path every effect had to go through).

**Design**: a library (`packages/cinematic-engine`) of self-contained **effect modules**, each implementing one shared interface:

```ts
interface Effect {
  name: string;
  apply(input: ClipRef, params: EffectParams): FfmpegFilterFragment;
}
```

Every effect the user listed maps to one module: Ken Burns, zoom, pan, blur transition, flash transition, glow, particles, film grain, camera shake, animated captions, lower thirds, year animations, statistic counters, timeline animations, cinematic overlays. Each module:
- Takes structured parameters only — never raw interpolated strings (this is what structurally closes the command-injection gap [Review §1.5, §11], not a one-off patch to a single call site).
- Produces an ffmpeg filter-graph *fragment*, composed together by one central `EffectComposer` rather than each effect independently building and running its own ffmpeg command — this is what lets multiple effects stack on one clip (e.g., Ken Burns + film grain + a lower-third) as one efficient ffmpeg pass instead of N sequential re-encodes.
- Is unit-testable in isolation (verify a Ken Burns fragment produces the expected filter-graph for given params, without running a full render).

**Effect selection**: driven entirely by the AI Director's EDL (§18) and the active Template (§22) — never hardcoded per-scene conditional logic. Adding a new effect means adding a new module + registering it; it does not mean touching the render pipeline's control flow, directly satisfying "the architecture must support future AI features" without every future feature being a `videoPipeline.ts` change.

## 20. Template Engine

**Design**: a Template is **data, not code**:

```ts
type Template = {
  id: string;                        // "documentary" | "viral" | "news" | ...
  colorPalette: ColorPalette;
  fontSet: { heading: string; caption: string; lowerThird: string };
  transitionDefaults: { in: TransitionType; out: TransitionType };
  effectIntensity: "subtle" | "moderate" | "bold";
  captionStyle: CaptionStyleRef;
  musicMood: string[];                // tags used to select background music
  pacingProfile: { avgShotDurationMs: number; allowFastCuts: boolean };
  visualIntelligenceThresholds: { minRelevanceScore: number };  // feeds §17.4
};
```

Initial template set (matching the user's list exactly): Documentary, History, Business, Luxury, Modern, Dark, Minimal, Viral, News, Educational — each is one definition file in `packages/templates/definitions/`. Both the AI Director (§18) and the Cinematic Editing Engine (§19) read from the active Template as their source of style defaults. **Adding a new style is a new data file, reviewable by a non-engineer (a designer or content lead), not an engineering task** — this is the concrete mechanism behind "the architecture must support future AI features" for the specific case of new video styles.

---

# Part IV — Media & Extensibility

## 21. Media Provider Framework

**Problem it solves**: v1 has ~6 independent implementations of "search and download footage from a source," each with its own hand-built retry/circuit-breaker logic added one at a time this session [Review §5.2, §6.1] — real, paid-for duplication (every new resilience improvement had to be built once per source).

**Design**: one interface, one registry, shared resilience infrastructure:

```ts
interface MediaProvider {
  id: string;                        // "pexels" | "wikimedia" | "user-uploads" | ...
  search(query: SearchQuery, opts: SearchOptions): Promise<MediaCandidate[]>;
  fetch(candidate: MediaCandidate): Promise<LocalFile>;
  getLicense(candidate: MediaCandidate): LicenseInfo;
  healthCheck(): Promise<boolean>;
  quotaRemaining?(): Promise<number | null>;   // for the cost-optimization quota-aware routing in §13
}
```

Every existing source (Pexels, Pixabay, Wikimedia, Openverse, Internet Archive, Europeana, curated archive, user uploads) becomes one plugin file implementing this interface, registered in `ProviderRegistry`. **Circuit breaker, retry-with-backoff, and rate limiting are provided by the framework itself** (`packages/media-providers/resilience`), wrapped automatically around every plugin's `search`/`fetch` calls — a plugin author writes only the source-specific query-building and response-parsing logic, and gets production-grade resilience for free, instead of hand-building a circuit breaker per source as happened three separate times this session. **A new provider is a new plugin file + one registry line — zero changes to the Visual Intelligence Engine, the pipeline, or any other provider**, which is exactly what the user asked for.

---

# Part V — Migration Plan

## 22. Phasing Overview

This is a redesign of the foundation, executed incrementally, in production, without a stop-the-world rewrite. Existing functionality is preserved at every phase — nothing in this plan requires FastVid to go offline or regress a currently-working feature while the migration happens.

### Phase 1 — Foundation (prerequisite for everything else)
- Redis + BullMQ queue, replacing DB-polling.
- Worker statelessness + checkpointing (per-stage `PipelineState` persistence).
- Object storage migration (R2), remove local-disk dependency.
- Security fixes (§11 table, in full).
- Docker multi-stage build + `.dockerignore` + GitHub Actions CI/CD + staging environment.
- Per-user AI budget/quota in the AI Gateway.
- WebSocket/SSE progress, replacing polling.

### Phase 2 — Pipeline Restructure
- Split `videoPipeline.ts` into the `packages/pipeline/stages/*` structure.
- Database schema fixes (§10): indexes reconciled, retention jobs built, connection pool formula.
- Frontend code-splitting fixes (lazy-load Streamdown/Admin route — the single highest-ROI frontend fix identified in the review).

### Phase 3 — Intelligence Layer (the competitive differentiation)
- Visual Intelligence Engine (§17).
- AI Director + Edit Decision List (§18).
- Cinematic Editing Engine as a proper effect-module library (§19).
- Template Engine (§20), initial 10 templates.
- Media Provider Framework formalized as plugins (§21).

### Phase 4 — Enterprise & Scale
- REST v1 API + API keys + rate limiting for programmatic access.
- Team/org accounts, role-based access beyond today's simple user/admin.
- Read replica, multi-region rendering (workers closer to where footage sources/users are).
- White-label / embeddable rendering for enterprise customers.

Each phase ships independently and is individually valuable — Phase 1 alone (queue + statelessness + storage + security) already resolves the majority of the Critical/High findings in the architecture review, before a single new AI capability is built.

---

## Closing Note

This document is a design, not a commitment to a specific timeline or team size — that's a planning conversation, not an architecture one. Every decision above traces back either to a concrete, verified finding in the architecture review, or to a stated product requirement in this specification's brief. Nothing here has been implemented. Awaiting direction on which phase to approve for implementation.
