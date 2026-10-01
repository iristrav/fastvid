/**
 * ONE ROUTE — THE SETTINGS AN OPERATOR ACTUALLY DECIDES, IN ONE PLACE.
 *
 * Each setting below is read here and nowhere else. Every getter reads the environment when it is
 * asked, not at import, so a worker picks up its own environment and a test can set one variable
 * without reloading modules — the same behaviour each reader had before it moved here. The names
 * and the defaults are unchanged.
 *
 * What is NOT here, on purpose:
 *   - secrets and service addresses (API keys, tokens, DATABASE_URL, S3_*): they are credentials,
 *     not decisions, and stay with the client that uses them (`_core/env.ts` for the LLM);
 *   - tuning numbers and feature flags whose production value has not been confirmed: folding a
 *     flag into a constant changes what production does, so each one needs the owner's word first.
 *
 * `formatConfigPresence` prints, at start-up, which of these names are SET or MISSING — never a
 * value.
 */
import { readQueueConfig } from "../shared/videoQueue";
import { envFlagIsNotOff, envFlagIsOn } from "./envFlag";

/** The environment names this module owns, in the order the start-up line prints them. */
export const CONFIG_SETTINGS = [
  "ALLOW_OPERATOR_LICENSED_YOUTUBE",
  "ALLOW_UNVERIFIED_YOUTUBE",
  "ENABLE_YOUTUBE_FAIR_USE",
  "ENABLE_YOUTUBE_STANDARD_LICENSE",
  "REQUIRE_YOUTUBE_MIN_SECONDS",
  "YOUTUBE_SEARCH_PASSES",
  "SEARCH_GATE_STRICT",
  "PIPELINE_WALL_CLOCK_LIMIT",
  "PIPELINE_WALL_CLOCK_GRACE",
  "MAX_CONCURRENT_RENDERS",
  "MAX_CONCURRENT_RENDER_JOBS",
] as const;

/** One line per setting: SET or MISSING (default applies). Names only — a value is never printed. */
export function formatConfigPresence(env: NodeJS.ProcessEnv = process.env): string[] {
  return CONFIG_SETTINGS.map(
    (name) => `[Config] ${name}=${env[name]?.trim() ? "SET" : "MISSING (default)"}`
  );
}

/* ═══════════════════════ YouTube licence ═══════════════════════ */

/**
 * Is the operator willing to use YouTube-origin material whose rights FastVid cannot prove?
 *
 * Default false, and false is the current behaviour exactly — an unset variable changes nothing.
 * Read at call time rather than captured at import, so the worker picks it up from its own
 * environment without a code change.
 */
export function allowUnverifiedYoutube(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_UNVERIFIED_YOUTUBE?.trim().toLowerCase() === "true";
}

/**
 * RONDE 147 — is the operator's YouTube authorisation in force?
 *
 * The FastVid owner states they hold authorisation to use YouTube content, and asked for that to
 * apply to YouTube as a whole rather than clip by clip. One switch, therefore, and it is the
 * authorisation itself:
 *
 *     ALLOW_OPERATOR_LICENSED_YOUTUBE=false              RONDE 124's flow, untouched
 *     anything else, including unset (default)           every youtube-* item is allowed
 *
 * ── RONDE 141: the default is now ON, and why that is a deliberate flip ──────────────────────
 *
 * RONDE 147 built this switch and left it off, because the authorisation it represents was not
 * this code's to assume. The FastVid owner has since given it explicitly and in writing — "hij mag
 * gewoon alles van het web en van youtube halen, ik heb daar akkoord voor" — for YouTube as a
 * whole. An authorisation that has actually been given is not something an operator should have to
 * remember to re-enter as an environment variable on every deployment; leaving it off would mean
 * the code kept refusing material the owner has said it may use.
 *
 * What did NOT change is everything the switch does once it is on. The metadata verdict is still
 * recorded per item, the status is still OPERATOR_AUTHORIZED and never VERIFIED, and the usage
 * report still marks every one of these with ⛔ and the sentence saying FastVid verified no right
 * to it. The authorisation is the owner's; the record of what was known when they gave it is
 * FastVid's, and that record is exactly as complete as it was before.
 *
 * `=false` still switches it back off, in one variable, with no code change.
 *
 * Read at call time rather than captured at import, so the worker picks it up from its own
 * environment without a code change.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────────────────────
 *
 * It does not change `classifyArchiveLicense`. A `-nc` or `-nd` licence still classifies as
 * REJECTED and an empty field still classifies as UNVERIFIED, whatever this flag is set to; the
 * decision keeps that verdict on `metadataStatus` so it survives the override. Nothing in this
 * module is made to claim a licence that the metadata does not show — RONDE 124's founding rule,
 * unchanged.
 *
 * It also does not produce VERIFIED. The override's own status is `OPERATOR_AUTHORIZED`, which
 * exists precisely so "the operator permits this" never has to borrow the word for "the licence
 * was verified". VERIFIED stays reachable only through the flow that earns it.
 *
 * ── What the operator is taking on ───────────────────────────────────────────────────────────
 *
 * A REJECTED classification means the UPLOADER chose "non-commercial" or "no derivative works" on
 * their own video. That choice belongs to the uploader rather than to the platform. Switching this
 * on asserts an authorisation from elsewhere, for YouTube material generally. The assertion is
 * recorded on every decision it carries — `operatorAuthorized`, `licenseBasis`, and the log line —
 * so the record always shows what was known and who decided to proceed anyway.
 */
export function allowOperatorLicensedYoutube(env: NodeJS.ProcessEnv = process.env): boolean {
  /**
   * Only the literal `false` switches it off.
   *
   * Not `!== "true"` inverted into a truthiness test: a typo (`ALLOW_OPERATOR_LICENSED_YOUTUBE=no`)
   * must not silently disable an authorisation the owner has given, and the one word that means
   * "off" should be the one word that turns it off. The same shape the pipeline's other
   * default-on flags use.
   */
  return env.ALLOW_OPERATOR_LICENSED_YOUTUBE?.trim().toLowerCase() !== "false";
}

/** Standard YouTube (non-CC) allowed when transformed for fair use (default on). */
export function youtubeFairUseEnabled(): boolean {
  return envFlagIsNotOff("ENABLE_YOUTUBE_FAIR_USE");
}

/**
 * RONDE 160 — the EXPLICIT standard-licence pass (`videoLicense=youtube`).
 *
 * ── How this differs from the two passes that already exist ────────────────────────────────
 *
 * `creative_common` asks YouTube for CC-licensed videos only. `any` sends no licence filter at
 * all, so it returns whatever ranks best — CC and standard mixed, with no way to tell which is
 * which from the search response. This third mode asks for the OPPOSITE of the first: videos
 * YouTube reports as carrying its standard licence, and nothing else.
 *
 * That makes it useful for two things the other two cannot do: sourcing material that is
 * deliberately outside CC, and — because the mode is now recorded on the lineage — being able to
 * answer afterwards WHICH licence a clip in a finished video was retrieved under.
 *
 * ── It used to be off by default, and the reason for that has been withdrawn ────────────────
 *
 * RONDE 160 left it off because it "can only ever return non-CC material, so switching it on is a
 * licensing decision the operator makes deliberately". The operator has since made that decision,
 * for YouTube as a whole, and `allowOperatorLicensedYoutube` is where it is recorded. Under that
 * authorisation this pass is a retrieval question rather than a licensing one, and leaving it off
 * would mean the pipeline kept declining to look at material the project is permitted to use.
 *
 * `ENABLE_YOUTUBE_STANDARD_LICENSE=false` still switches it back off. With the authorisation
 * withdrawn (`ALLOW_OPERATOR_LICENSED_YOUTUBE=false`) it returns to opt-in, exactly as RONDE 160
 * left it.
 */
export function youtubeStandardLicenseEnabled(): boolean {
  return allowOperatorLicensedYoutube()
    ? envFlagIsNotOff("ENABLE_YOUTUBE_STANDARD_LICENSE")
    : envFlagIsOn("ENABLE_YOUTUBE_STANDARD_LICENSE");
}

/** Optional product requirement. Unset, blank, zero or unparseable: no requirement. */
export function requiredYoutubeSeconds(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.REQUIRE_YOUTUBE_MIN_SECONDS?.trim();
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * RONDE 650 — HOW MANY LICENCE PASSES ONE QUERY MAY SPEND.
 *
 * The YouTube Data API allows 10,000 units a day and a search costs 100. With three passes per
 * query and two queries per turn, one beat's turn cost 600 units, and a beat asks through the
 * lookahead, its own turn and the rescue routes. Render 607 ran the key dry at 18:18
 * (`YouTube fair-use API error 429`) and the rest of it searched through the scraped fallback,
 * which answered with memes and a mobile game.
 *
 * The first pass is the widest one the policy allows (`any` under the operator's authorisation, so
 * it already contains what the CC and standard passes would return). One pass per query is the
 * default; `YOUTUBE_SEARCH_PASSES=3` restores every pass.
 */
export function youtubeSearchPassesPerQuery(): number {
  const raw = Number(process.env.YOUTUBE_SEARCH_PASSES?.trim());
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/* ═══════════════════════ judging and delivery ═══════════════════════ */

/**
 * Is the gate refusing unverified queries outright?
 *
 * RONDE 90 (§1): ON unless somebody explicitly turns it off. RONDE 89 shipped it OFF because
 * turning it on would have blocked every call site that could not supply a context — which was
 * all of them, because nothing minted a verified query anywhere in the pipeline. That is now
 * fixed at the source: the beat's proven context is ambient (withSearchProvenance), so the gate
 * can verify a query the caller passed as a bare string.
 *
 * The default matters more than the flag. A safety property that has to be switched on is a
 * safety property that is off in production, and "unproven content may not reach a provider" is
 * not a mode — it is the contract. `SEARCH_GATE_STRICT=false` remains, for one purpose only: to
 * measure what strict mode is blocking without having to ship a code change to find out.
 */
export function searchGateStrict(): boolean {
  return process.env.SEARCH_GATE_STRICT !== "false";
}



/* ═══════════════════════ time and capacity ═══════════════════════ */

/** Multiplier on target budget before hard-fail (default 1.3 → ~13 min pipeline per 1 min video). */
export function pipelineWallClockGraceFactor(): number {
  const raw = process.env.PIPELINE_WALL_CLOCK_GRACE?.trim();
  if (raw) {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 1.05 && n <= 1.5) return n;
  }
  return 1.3;
}

/**
 * When true, enforce hard wall-clock fail + router race timeout. Default ON.
 *
 * RONDE 30: this doc comment used to say "Default OFF — jobs finish at their own pace", which
 * contradicted the code below it. Two test files (beatVisualRescue, pipelineStall) asserted the
 * documented OFF and had been failing ever since, unnoticed inside the known-failing baseline.
 *
 * Corrected the comment rather than the code: the watchdog work from RONDE 20/21/25 is built on
 * a render budget existing — RenderWatchdog derives its idle limit from the whole render budget,
 * and maxPipelineWallClockMin() returns PIPELINE_UNLIMITED_MS when this is off. Flipping the
 * default to match the old comment would silently remove the ceiling that stops a hung render
 * from running for hours. That is a product decision, not a test repair, so it is flagged rather
 * than made here.
 */
export function pipelineWallClockLimitEnabled(): boolean {
  return process.env.PIPELINE_WALL_CLOCK_LIMIT !== "false";
}

/**
 * How many renders this process may have in flight at once.
 *
 * Defaults to the queue's own per-worker cap so nothing changes for an existing deployment: that
 * value is 1 unless MAX_JOBS_PER_WORKER is set, which is why renders have effectively serialised
 * on a single worker until now. Setting MAX_CONCURRENT_RENDERS makes the intent explicit and
 * lets it be lowered independently of the queue's job accounting.
 */
export function maxConcurrentRenders(): number {
  const explicit = process.env.MAX_CONCURRENT_RENDERS?.trim();
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (!isNaN(n) && n >= 1 && n <= 16) return n;
  }
  return Math.max(1, readQueueConfig().maxJobsPerWorker);
}

/** How many renders this process runs at once. One by default: ffmpeg is not a light guest. */
export function maxConcurrentRenderJobs(): number {
  const raw = parseInt(process.env.MAX_CONCURRENT_RENDER_JOBS ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
