/**
 * RONDE 191 — is this environment able to render a real video, and if not, what exactly is missing?
 *
 * ── Why this is a module and not a paragraph in a report ─────────────────────────────────────
 *
 * Every round since R160 has ended the same way: "PRODUCTION_RENDER_BLOCKED — these keys are unset."
 * That sentence was written by hand each time, from a shell loop that existed for one conversation
 * and then vanished. The operator who eventually has the credentials gets a prose list to
 * re-derive rather than a command to run.
 *
 * So the check lives in the repository, next to the code whose requirements it describes, and the
 * next attempt is one call. It answers three questions the prose could not:
 *
 *   · which CAPABILITY is blocked, not just which variable is unset — an operator does not care
 *     that `NARA_API_KEY` is missing, they care that the archival sources are down to four;
 *   · what is REACHABLE, not merely configured — a DATABASE_URL that points nowhere is worse than
 *     no DATABASE_URL, because it looks like readiness;
 *   · what would actually run, given the flags that are set right now.
 *
 * ── The rule this module exists to obey ──────────────────────────────────────────────────────
 *
 * It reports PRESENCE and never a value. Not truncated, not masked, not the first four characters:
 * a preflight is exactly the kind of diagnostic that gets pasted into an issue, and a masked key is
 * still a key that has been written down somewhere it should not be. `envPresence` returns a
 * boolean and there is no code path in this file that can put a credential into a string.
 */

/**
 * The production storage decision, imported rather than restated.
 *
 * `storageBackend.ts` has no imports of its own, so this stays a module a test can load without a
 * database, a filesystem or a network — which is the property that makes a preflight testable.
 */
import { getStorageBackend } from "./storageBackend";
import { clipModelCacheLocation } from "./clipModelCache";
import { envFlagIsOn } from "./envFlag";

/* ═══════════════════════ what production needs ═══════════════════════ */

/** One capability the pipeline has, and the variables without which it cannot work. */
export type Capability = {
  id: string;
  /** What a person loses when this is blocked, in their words rather than the code's. */
  describes: string;
  /** ALL of these must be present. */
  requires: readonly string[];
  /** At least ONE of these must be present, when the list is non-empty. */
  requiresAny?: readonly string[];
  /** Blocked capabilities that make a real render impossible, rather than poorer. */
  fatal: boolean;
  /**
   * RONDE 205 — the capability is decided by PRODUCTION CODE, not by this file's opinion.
   *
   * Env presence is a proxy, and a proxy drifts. Where the pipeline already has a function that
   * answers "is this configured" — `getStorageBackend` is the case that motivated this — the
   * preflight calls THAT function, so the two can never disagree about what configured means.
   * Returning a detail string lets the report say which backend was chosen rather than only that
   * one was.
   */
  satisfiedBy?: (env: NodeJS.ProcessEnv) => { available: boolean; detail: string };
  /**
   * RONDE 205 — is this capability required AT ALL in this configuration?
   *
   * Redis is the case: it is needed only when `QUEUE_BACKEND=bullmq`. Reporting it as DEGRADED on
   * every deployment that uses the default DB-polling queue tells an operator to go and provision
   * something the code will never open, which is worse than silence.
   */
  requiredWhen?: (env: NodeJS.ProcessEnv) => boolean;
};

/**
 * The capability map.
 *
 * `fatal` marks the ones without which there is no video at all — not the ones that would be nice
 * to have. A render with four archival sources instead of eight is a worse video; a render with no
 * database is not a video.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "database",
    describes: "storing the video, its timeline and its render jobs",
    requires: ["DATABASE_URL"],
    fatal: true,
    /**
     * RONDE 205 — the SCHEME, not just the presence.
     *
     * FastVid is MySQL: `getDb()` opens a `mysql2/promise` pool and returns null outright for any
     * URL that does not start `mysql://` or `mysql2://`, with nothing but a console warning. So a
     * DATABASE_URL pointing at Postgres is the worst of the three states — it passes every
     * presence check, the app boots, and every database call quietly does nothing.
     *
     * The preflight used to call this probe "postgres", which actively sent an operator to
     * provision the wrong engine. Checked here so the report says so before the credentials are
     * bought rather than after.
     */
    satisfiedBy: (env) => {
      const raw = (env.DATABASE_URL ?? "").trim();
      if (!raw) return { available: false, detail: "missing DATABASE_URL" };
      if (!/^mysql2?:\/\//i.test(raw)) {
        return {
          available: false,
          detail: "DATABASE_URL is set but is not a mysql:// URL — FastVid uses MySQL and getDb() refuses anything else",
        };
      }
      return { available: true, detail: "MySQL URL configured" };
    },
  },
  {
    id: "narration",
    describes: "the voice-over. ElevenLabs, Fish Audio and Google TTS are alternatives, not a chain",
    requires: [],
    /**
     * RONDE 205 — three providers, not one.
     *
     * This required ELEVENLABS_API_KEY and nothing else, and marked it fatal — so a deployment
     * with a perfectly good Google TTS key was told it could not render at all. `videoPipeline`
     * reads all three and `sourcingPolicy` has an explicit fallback for each.
     */
    requiresAny: [
      "ELEVENLABS_API_KEY",
      "FISH_AUDIO_API_KEY",
      "GOOGLE_TTS_API_KEY",
      "GOOGLE_CLOUD_TTS_API_KEY",
    ],
    fatal: true,
  },
  {
    id: "word_timing",
    /**
     * Split out of `narration` in R205, because they have different providers and different
     * consequences. `ttsWordAlignmentEnabled()` returns true only for ElevenLabs — it is the one
     * provider that returns per-word timings — so a render on Google TTS gets a voice-over and
     * whole-line captions, and no karaoke. That is a DEGRADED video, not a blocked one.
     */
    describes: "per-word timing, which karaoke captions are built from. ElevenLabs only",
    requires: ["ELEVENLABS_API_KEY"],
    fatal: false,
  },
  {
    id: "script",
    describes: "writing the script and the Director's narrative judgement",
    requires: [],
    requiresAny: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
    fatal: true,
  },
  {
    id: "stock_footage",
    describes: "Pexels and Pixabay — the modern-footage half of retrieval",
    requires: [],
    requiresAny: ["PEXELS_API_KEY", "PIXABAY_API_KEY"],
    fatal: false,
  },
  {
    id: "archival_sources",
    describes: "Europeana and NARA. Wikimedia, Internet Archive, LoC and NASA need no key",
    requires: [],
    requiresAny: ["EUROPEANA_API_KEY", "NARA_API_KEY"],
    fatal: false,
  },
  {
    id: "youtube_search",
    describes: "finding YouTube candidates at all",
    requires: ["YOUTUBE_API_KEY"],
    fatal: false,
  },
  {
    id: "youtube_download",
    describes: "fetching a YouTube winner. Without it a YouTube clip can be ranked and never used",
    requires: [],
    requiresAny: ["YOUTUBE_CC_DL_SERVICE", "RAPIDAPI_KEY"],
    fatal: false,
  },
  {
    id: "ambience",
    describes: "Freesound room tone. Music has no source in this build either way",
    requires: ["FREESOUND_API_KEY"],
    fatal: false,
  },
  {
    id: "image_search",
    describes: "SerpAPI stills, for beats no video source can cover",
    requires: ["SERPAPI_KEY"],
    fatal: false,
  },
  {
    id: "storage",
    describes: "where the finished MP4 is written",
    requires: [],
    /**
     * RONDE 205 — this entry was wrong in both directions, and it was the round's biggest finding.
     *
     * It said `S3_BUCKET` OR `APP_URL`, and it was fatal. Both halves were false:
     *
     *   · APP_URL is not a storage mechanism at all. It is the canonical public URL, read by
     *     `_core/appUrl.ts` for Stripe redirects and password-reset emails. Both the render worker
     *     and the rehydrator go out of their way to NOT need it — they copy their own files off
     *     disk precisely so that a missing APP_URL cannot turn into a mysterious render failure.
     *   · S3_BUCKET alone buys nothing. `isS3StorageEnabled` needs the bucket AND
     *     S3_ACCESS_KEY_ID AND S3_SECRET_ACCESS_KEY, so a deployment with only the bucket set was
     *     told storage was fine while `getStorageBackend()` quietly returned "local".
     *
     * And it is not fatal, because there is no configuration in which storage is absent:
     * `getStorageBackend()` falls through S3 → Forge → local disk. Local disk WORKS; on Railway
     * without a mounted volume it is ephemeral, which is a real problem worth reporting and a
     * completely different one from "no video can be produced".
     *
     * Asking the production function rather than restating its rule is the point — see
     * `satisfiedBy`. The two cannot drift apart, because there is only one of them.
     */
    satisfiedBy: (env) => {
      const backend = getStorageBackend(env);
      if (backend === "s3") return { available: true, detail: "S3/R2 — bucket and keys configured" };
      if (backend === "forge") return { available: true, detail: "Manus Forge object storage" };
      return {
        available: true,
        detail:
          "local disk — WORKS, but is ephemeral unless a volume is mounted. " +
          "For durable storage set S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY",
      };
    },
    fatal: false,
  },
  {
    id: "queue",
    describes: "the render queue. The default polls the database; Redis is only for the BullMQ backend",
    requires: ["REDIS_URL"],
    /**
     * RONDE 205 — required only when somebody asked for it.
     *
     * `server/queue/index.ts` uses the DB-polling queue unless `QUEUE_BACKEND=bullmq`, and it
     * refuses to boot with that flag set and no REDIS_URL. So on a default deployment Redis is not
     * degraded, it is NOT REQUIRED — and reporting it as missing sends an operator to provision a
     * service this code will never open.
     */
    requiredWhen: (env) => (env.QUEUE_BACKEND ?? "").trim() === "bullmq",
    fatal: true,
  },
];

/* ═══════════════════════ presence, never value ═══════════════════════ */

/**
 * Is this variable set to something non-empty?
 *
 * Returns a BOOLEAN. Nothing in this module ever returns, logs, hashes, truncates or masks the
 * value itself — a preflight report is pasted into issues and chat windows, and a masked key is
 * still a key that has been written down where it should not be.
 */
export function envPresence(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * RONDE 205 — four states, because three of them used to be spelled the same way.
 *
 * `available` alone could not distinguish "this is missing and nothing works", "this is missing
 * and the video is poorer" and "this is missing and it does not apply to your configuration". An
 * operator acts completely differently on each, and the third was the one being reported as a
 * problem to fix.
 */
export type CapabilityState = "available" | "degraded" | "blocked" | "not_required";

export type CapabilityStatus = {
  id: string;
  describes: string;
  available: boolean;
  state: CapabilityState;
  fatal: boolean;
  /** The variables that are not set. Names only — see `envPresence`. */
  missing: string[];
  /** Set when the capability needs any ONE of a group and has none of them. */
  missingAnyOf: string[];
  /** What the production check said, when this capability is decided by code rather than presence. */
  detail?: string;
};

export function checkCapability(
  cap: Capability,
  env: NodeJS.ProcessEnv = process.env
): CapabilityStatus {
  /** Not applicable to this configuration — reported, never counted against the render. */
  if (cap.requiredWhen && !cap.requiredWhen(env)) {
    return {
      id: cap.id,
      describes: cap.describes,
      available: true,
      state: "not_required",
      fatal: cap.fatal,
      missing: [],
      missingAnyOf: [],
      detail: "not required in this configuration",
    };
  }

  /**
   * The production function wins where there is one. It is the same code the render will run, so
   * a disagreement between it and this report is impossible by construction rather than by care.
   */
  if (cap.satisfiedBy) {
    const verdict = cap.satisfiedBy(env);
    return {
      id: cap.id,
      describes: cap.describes,
      available: verdict.available,
      state: verdict.available ? "available" : cap.fatal ? "blocked" : "degraded",
      fatal: cap.fatal,
      missing: verdict.available ? [] : [...cap.requires],
      missingAnyOf: [],
      detail: verdict.detail,
    };
  }

  const missing = cap.requires.filter((n) => !envPresence(n, env));
  const anyGroup = cap.requiresAny ?? [];
  const hasAny = anyGroup.length === 0 || anyGroup.some((n) => envPresence(n, env));
  const available = missing.length === 0 && hasAny;
  return {
    id: cap.id,
    describes: cap.describes,
    available,
    state: available ? "available" : cap.fatal ? "blocked" : "degraded",
    fatal: cap.fatal,
    missing,
    missingAnyOf: hasAny ? [] : [...anyGroup],
  };
}

/* ═══════════════════════ the machine, not the configuration ═══════════════════════ */

export type ToolStatus = { id: string; available: boolean; detail: string };

/**
 * What this host can actually do, as opposed to what it has been told.
 *
 * Injected rather than imported so the check itself is testable without a filesystem: the point of
 * a preflight is that it runs in the environment it is describing, and a test that had to mock a
 * binary would be testing the mock.
 */
export type HostProbes = {
  hasBinary: (name: string) => boolean;
  hasBrowser: () => boolean;
  /** Attempted CONNECTION, not the presence of a URL — a URL pointing nowhere looks like readiness. */
  canReachDatabase: () => Promise<boolean>;
  canReachRedis: () => Promise<boolean>;
  /**
   * RONDE 95 FINAL — can the picture editor actually be loaded on this host?
   *
   * This is the probe RONDE 94 made critical and nothing checked. `beatClipPassesVisionGate` fails
   * open when the local CLIP model will not load, so a render on a host without it does not crash:
   * every picture reads as `unknown`, `visionPipelineIsUnavailable()` becomes true, the adoption
   * guard suspends the vision requirement render-wide, no beat acquires a verified visual, and
   * RONDE 89's export gate then refuses the finished film.
   *
   * That is a render that runs for hours and is thrown away at the last gate. It is precisely the
   * case a preflight exists to move to the front, and it could not be seen from the environment:
   * there is no key for it and no URL — the model either loads on this machine or it does not.
   */
  canLoadVisionModel: () => Promise<boolean>;
};

export async function checkHost(probes: HostProbes, env: NodeJS.ProcessEnv = process.env): Promise<ToolStatus[]> {
  const out: ToolStatus[] = [];
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const ok = probes.hasBinary(bin);
    out.push({ id: bin, available: ok, detail: ok ? "on PATH" : "not found — no render is possible" });
  }
  const browser = probes.hasBrowser();
  out.push({
    id: "chrome_headless_shell",
    available: browser,
    detail: browser
      ? "Remotion can draw graphics and captions"
      : "absent — the render falls back to libass, and graphics are not drawn",
  });

  /**
   * A configured-but-unreachable service is reported as UNREACHABLE and an unconfigured one as
   * NOT CONFIGURED. They are different problems: the first is an outage or a wrong URL, the second
   * is a deployment that was never given the value, and an operator acts differently on each.
   */
  /**
   * RONDE 205 — called `mysql`, because that is what FastVid opens.
   *
   * This probe was labelled `postgres`. `getDb()` builds a `mysql2/promise` pool and rejects any
   * URL that is not `mysql://` or `mysql2://`, so the label was telling an operator to provision
   * the one engine guaranteed not to work — and a Postgres URL fails silently, since getDb()
   * returns null with a console warning and every caller degrades to "no database".
   */
  if (!envPresence("DATABASE_URL", env)) {
    out.push({ id: "mysql", available: false, detail: "not configured — DATABASE_URL is unset" });
  } else {
    const ok = await probes.canReachDatabase();
    out.push({ id: "mysql", available: ok, detail: ok ? "reachable" : "CONFIGURED BUT UNREACHABLE" });
  }
  /**
   * RONDE 95 FINAL — the model, probed by loading it, not by reading a variable.
   *
   * Reported for every deployment, and turned into a BLOCKER only when funnel adoption is
   * enforced — see the verdict below. Loading is what the render itself does, so a probe that
   * merely looked for a file would be answering a different question than the one that matters.
   */
  const vision = await probes.canLoadVisionModel();
  out.push({
    id: "clip_vision",
    available: vision,
    detail: vision
      ? "the picture editor loads — beats can earn an APPROVED verdict"
      : "WILL NOT LOAD — every picture reads as unknown, no beat can become a verified visual, " +
        "and the export gate refuses the finished film",
  });

  /**
   * WHERE THAT MODEL IS KEPT — which the previous line cannot tell you.
   *
   * `clip_vision` above answers "does it load", and on 2026-09-05 it answered OK eleven times in
   * fifty minutes — because eleven worker boots each downloaded 350MB again. The volume is mounted
   * on the web service; the worker, which is the process that renders, has none, so its cache falls
   * through to `os.tmpdir()` and is gone with the container.
   *
   * That is not a blocker: the model still loads and the render still runs. It is a cost that was
   * invisible, paid on every deploy and by every replica, and a preflight is where it belongs.
   *
   * This is the one host entry that prints a value read from the environment, and deliberately: a
   * directory is the thing an operator has to act on, and none of the variables it can come from
   * (`TRANSFORMERS_CACHE`, `HF_HOME`, `XDG_CACHE_HOME`, `UPLOADS_DIR`, `RAILWAY_VOLUME_MOUNT_PATH`)
   * is a credential. R191's leak test covers every variable that is one, and none of these is in it.
   */
  /**
   * The real environment is passed as `undefined`, not as `process.env`: by the time a preflight
   * runs, the warm-up has already written its chosen directory back into `TRANSFORMERS_CACHE`, and
   * `clipModelCacheLocation` keeps a pre-warm-up snapshot precisely so this line reports the rule
   * that CHOSE the directory rather than the process's own echo of it. A test naming its own
   * environment gets that one used verbatim.
   */
  const cache = clipModelCacheLocation(env === process.env ? undefined : env);
  out.push({
    id: "clip_model_cache",
    available: cache.persists,
    detail: cache.persists
      ? `${cache.dir} — ${cache.why}, downloaded once`
      : `${cache.dir} — ${cache.why}`,
  });

  /** Only probed when the configuration actually opens it — see the `queue` capability. */
  if ((env.QUEUE_BACKEND ?? "").trim() !== "bullmq") {
    out.push({ id: "redis", available: true, detail: "not required — QUEUE_BACKEND is not bullmq" });
  } else if (!envPresence("REDIS_URL", env)) {
    out.push({ id: "redis", available: false, detail: "not configured — REDIS_URL is unset" });
  } else {
    const ok = await probes.canReachRedis();
    out.push({ id: "redis", available: ok, detail: ok ? "reachable" : "CONFIGURED BUT UNREACHABLE" });
  }
  return out;
}

/* ═══════════════════════ the verdict ═══════════════════════ */

export type PreflightReport = {
  capabilities: CapabilityStatus[];
  host: ToolStatus[];
  /** The route flags, as they are set right now. Absent means the route does not run. */
  routes: Array<{ flag: string; on: boolean }>;
  /**
   * RONDE 205 — three verdicts, because "not perfect" and "not possible" are different answers.
   *
   * POSSIBLE means everything is there. DEGRADED means a render will run and produce a real video
   * that is missing something optional — fewer retrieval sources, no karaoke, ephemeral storage.
   * BLOCKED means there is no video at all.
   *
   * The old two-verdict version reported BLOCKED for both of the last two, so an operator could
   * not tell "you cannot start" from "you can start, and here is what will be thinner".
   */
  verdict: "PRODUCTION_RENDER_POSSIBLE" | "PRODUCTION_RENDER_DEGRADED" | "PRODUCTION_RENDER_BLOCKED";
  blockers: string[];
  /** What will be missing from a render that runs anyway. Never a reason not to start. */
  degradations: string[];
};

/**
 * The flags a real production render is run with, and their current state.
 *
 * Reported rather than required: a render with them off is a valid render of the legacy route, and
 * an operator who forgot to set them should be able to see that in the same place they see
 * everything else, rather than discovering it from a video that took the old path.
 */
export const ROUTE_FLAGS = [
  "CINEMATIC_EDITING_ENGINE",
  "CINEMATIC_RENDER_PATH",
  "POOL_RANKING_V2",
  "ENABLE_YOUTUBE_SOURCING",
  "AI_DIRECTOR",
] as const;

export async function productionPreflight(
  probes: HostProbes,
  env: NodeJS.ProcessEnv = process.env
): Promise<PreflightReport> {
  const capabilities = CAPABILITIES.map((c) => checkCapability(c, env));
  const host = await checkHost(probes, env);
  /**
   * RENDER 569 — THE REPORT AND THE PIPELINE READ THE SAME VARIABLE DIFFERENTLY.
   *
   * Six boots of that worker printed `[Preflight] OFF ENABLE_YOUTUBE_SOURCING`, and the same log
   * printed `[Fastvid] YouTube clip sourcing: enabled youtube=ready`. Both were right about their
   * own reading: `youtubeSourcingEnabled()` goes through `envFlagIsOn`, which trims and
   * lowercases, while this line did a bare `=== "true"`. A variable set to `TRUE`, or with a
   * trailing space, is ON for the pipeline and OFF in the report describing it.
   *
   * RONDE 18 already learned this — "a stray capital silently disables a whole source" — and
   * fixed the pipeline's reader. The preflight kept its own, which makes it the one place an
   * operator looks that could tell them the opposite of the truth. Same reader now, from
   * ./envFlag, which is import-free precisely so this module's CLI can still run from anywhere.
   */
  const routes = ROUTE_FLAGS.map((flag) => ({ flag, on: envFlagIsOn(flag, env) }));

  const blockers: string[] = [];
  const degradations: string[] = [];
  for (const c of capabilities) {
    if (c.state === "available" || c.state === "not_required") continue;
    const names = [...c.missing, ...c.missingAnyOf];
    const why = names.length > 0 ? ` — needs ${names.join(" or ")}` : c.detail ? ` — ${c.detail}` : "";
    (c.state === "blocked" ? blockers : degradations).push(`${c.id}: ${c.describes}${why}`);
  }
  for (const h of host) {
    /** The two binaries and the database: without any of them there is no video to degrade. */
    if (!h.available && (h.id === "ffmpeg" || h.id === "ffprobe" || h.id === "mysql")) {
      blockers.push(`${h.id}: ${h.detail}`);
    }
    /** A missing browser is the textbook degradation: the render runs, graphics are not drawn. */
    if (!h.available && h.id === "chrome_headless_shell") {
      degradations.push(`${h.id}: ${h.detail}`);
    }
    /** An unkept model cache costs time and bandwidth on every boot; it never costs a video. */
    if (!h.available && h.id === "clip_model_cache") {
      degradations.push(`${h.id}: ${h.detail}`);
    }
    /**
     * RONDE 95 FINAL — a missing picture editor is fatal exactly when the gate is enforced.
     *
     * Not an opinion about how good the film would be: with `ENFORCE_FUNNEL_ADOPTION` on (the
     * default since RONDE 94) a render without CLIP is GUARANTEED to be refused by RONDE 89's
     * export gate, because no beat can hold a verified visual. Starting it wastes the whole run.
     *
     * With enforcement explicitly disabled the same render completes and ships unverified
     * footage — a worse film, not an impossible one — so it degrades rather than blocks. The
     * verdict follows the configuration rather than guessing at it.
     */
    if (!h.available && h.id === "clip_vision") {
      const enforced = (env.ENFORCE_FUNNEL_ADOPTION ?? "") !== "false";
      (enforced ? blockers : degradations).push(
        `${h.id}: ${h.detail}` +
          (enforced
            ? " (ENFORCE_FUNNEL_ADOPTION is on, so this render would be refused at export)"
            : " (ENFORCE_FUNNEL_ADOPTION=false, so the render ships unverified footage instead)")
      );
    }
  }

  return {
    capabilities,
    host,
    routes,
    verdict:
      blockers.length > 0
        ? "PRODUCTION_RENDER_BLOCKED"
        : degradations.length > 0
          ? "PRODUCTION_RENDER_DEGRADED"
          : "PRODUCTION_RENDER_POSSIBLE",
    blockers,
    degradations,
  };
}

/**
 * The report as text, for a terminal or a log.
 *
 * Names and verdicts only. There is deliberately no parameter that could carry a value into this
 * function, so no future edit can make it print one by passing the wrong thing.
 */
export function formatPreflight(report: PreflightReport): string {
  const lines: string[] = ["[Preflight] === FastVid production preflight ==="];

  lines.push("[Preflight] capabilities:");
  for (const c of report.capabilities) {
    /**
     * RONDE 205 — the word an operator reads first is the word they act on.
     *
     * REQUIRED/MISSING is a thing to go and fix before starting; OPTIONAL/MISSING is a thing to
     * know about; NOT REQUIRED is a thing to stop worrying about. The old format spelled the last
     * two identically, which is how a Redis instance nobody needs became a task on a list.
     */
    const mark =
      c.state === "available" ? "AVAILABLE"
        : c.state === "not_required" ? "NOT REQ"
          : c.state === "blocked" ? "REQUIRED/MISSING"
            : "OPTIONAL/MISSING";
    const names = [...c.missing, ...c.missingAnyOf];
    const why = names.length > 0 ? ` — set ${names.join(" or ")}` : c.detail ? ` — ${c.detail}` : "";
    lines.push(`[Preflight]   ${mark.padEnd(17)} ${c.id.padEnd(18)} ${c.describes}${why}`);
  }

  lines.push("[Preflight] host:");
  for (const h of report.host) {
    lines.push(`[Preflight]   ${(h.available ? "OK" : "NO").padEnd(8)} ${h.id.padEnd(22)} ${h.detail}`);
  }

  lines.push("[Preflight] routes:");
  for (const r of report.routes) {
    lines.push(`[Preflight]   ${(r.on ? "ON" : "OFF").padEnd(8)} ${r.flag}`);
  }

  lines.push(`[Preflight] verdict=${report.verdict}`);
  for (const b of report.blockers) lines.push(`[Preflight]   blocker: ${b}`);
  for (const d of report.degradations) lines.push(`[Preflight]   degraded: ${d}`);
  return lines.join("\n");
}

/**
 * The same report, machine-readable — RONDE 206's configuration matrix.
 *
 * Derived from `CAPABILITIES` and the live environment rather than written out by hand, so it
 * cannot describe a configuration the code does not actually implement. Names only: the values are
 * never read into this structure, only their presence.
 */
export function preflightJson(report: PreflightReport): string {
  return JSON.stringify(
    {
      verdict: report.verdict,
      blockers: report.blockers,
      degradations: report.degradations,
      capabilities: report.capabilities.map((c) => ({
        id: c.id,
        state: c.state,
        required: c.fatal,
        describes: c.describes,
        missing: [...c.missing, ...c.missingAnyOf],
        ...(c.detail ? { detail: c.detail } : {}),
      })),
      host: report.host.map((h) => ({ id: h.id, available: h.available, detail: h.detail })),
      routes: report.routes,
    },
    null,
    2
  );
}
