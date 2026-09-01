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
  },
  {
    id: "narration",
    describes: "the voice-over, and the word timing captions and karaoke are built from",
    requires: ["ELEVENLABS_API_KEY"],
    fatal: true,
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
    describes: "putting the finished MP4 somewhere it survives the render",
    requires: [],
    requiresAny: ["S3_BUCKET", "APP_URL"],
    fatal: true,
  },
  {
    id: "queue",
    describes: "the render queue. Without Redis the worker runs in-process only",
    requires: ["REDIS_URL"],
    fatal: false,
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

export type CapabilityStatus = {
  id: string;
  describes: string;
  available: boolean;
  fatal: boolean;
  /** The variables that are not set. Names only — see `envPresence`. */
  missing: string[];
  /** Set when the capability needs any ONE of a group and has none of them. */
  missingAnyOf: string[];
};

export function checkCapability(
  cap: Capability,
  env: NodeJS.ProcessEnv = process.env
): CapabilityStatus {
  const missing = cap.requires.filter((n) => !envPresence(n, env));
  const anyGroup = cap.requiresAny ?? [];
  const hasAny = anyGroup.length === 0 || anyGroup.some((n) => envPresence(n, env));
  return {
    id: cap.id,
    describes: cap.describes,
    available: missing.length === 0 && hasAny,
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
  if (!envPresence("DATABASE_URL", env)) {
    out.push({ id: "postgres", available: false, detail: "not configured — DATABASE_URL is unset" });
  } else {
    const ok = await probes.canReachDatabase();
    out.push({ id: "postgres", available: ok, detail: ok ? "reachable" : "CONFIGURED BUT UNREACHABLE" });
  }
  if (!envPresence("REDIS_URL", env)) {
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
  /** READY when a real render can be attempted; BLOCKED names what stops it. */
  verdict: "PRODUCTION_RENDER_POSSIBLE" | "PRODUCTION_RENDER_BLOCKED";
  blockers: string[];
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
  const routes = ROUTE_FLAGS.map((flag) => ({ flag, on: (env[flag] ?? "") === "true" }));

  const blockers: string[] = [];
  for (const c of capabilities) {
    if (c.available || !c.fatal) continue;
    const names = [...c.missing, ...c.missingAnyOf];
    blockers.push(`${c.id}: ${c.describes} — needs ${names.join(" or ")}`);
  }
  for (const h of host) {
    /** Only the two that make a render impossible; a missing browser degrades, it does not block. */
    if (!h.available && (h.id === "ffmpeg" || h.id === "ffprobe" || h.id === "postgres")) {
      blockers.push(`${h.id}: ${h.detail}`);
    }
  }

  return {
    capabilities,
    host,
    routes,
    verdict: blockers.length === 0 ? "PRODUCTION_RENDER_POSSIBLE" : "PRODUCTION_RENDER_BLOCKED",
    blockers,
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
    const mark = c.available ? "OK     " : c.fatal ? "BLOCKED" : "DEGRADED";
    const why = c.available ? "" : ` — missing ${[...c.missing, ...c.missingAnyOf].join(" or ")}`;
    lines.push(`[Preflight]   ${mark.padEnd(8)} ${c.id.padEnd(18)} ${c.describes}${why}`);
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
  return lines.join("\n");
}
