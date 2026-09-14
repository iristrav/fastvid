/**
 * THE SERVICE WAS UP, THE PREFLIGHT SAID READY, AND NOT ONE BYTE ARRIVED.
 *
 * ── What render 581 reported about itself ───────────────────────────────────────────────────
 *
 *     [Preflight] AVAILABLE youtube_download_primary  the yt-dlp cloud service, which fetches
 *                 only the seconds a beat needs…
 *     [Preflight] verdict=PRODUCTION_RENDER_POSSIBLE
 *
 * ── What was actually happening, on every single candidate ──────────────────────────────────
 *
 *     Cloud DL service error 502 for ynJoy1OCeVQ:
 *     {"detail":"ERROR: [youtube] ynJoy1OCeVQ: Sign in to confirm you're not a bot…
 *
 *     [VisualFunnel] youtube_cc retrieved=2609 downloadSucceeded=0 adopted=0 finalVideo=0
 *
 * Three separate reports — the service's `/health`, the render's preflight, and the funnel — and
 * the first two were green for the whole render. `proxy: true` means a variable is set;
 * `AVAILABLE` means the same variable is set on the other side. Neither had asked YouTube
 * anything.
 *
 * These tests pin the three answers that follow from that: the service says whether it GOT
 * THROUGH, the render stops asking a route that is refusing its network identity, and the
 * preflight reports what the service answered rather than what was configured.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

import { checkHost, type HostProbes } from "./productionPreflight";
import {
  noteCloudEgressBlocked,
  cloudEgressRefusal,
  resetCloudEgressBlocked,
} from "./providerFailureClass";

const probes = (over: Partial<HostProbes> = {}): HostProbes => ({
  hasBinary: () => true,
  hasBrowser: () => true,
  canReachDatabase: async () => true,
  canReachRedis: async () => true,
  canLoadVisionModel: async () => true,
  ...over,
});

const YT = (extra: NodeJS.ProcessEnv = {}) =>
  ({ YOUTUBE_CC_DL_SERVICE: "https://dl.example", DATABASE_URL: "mysql://x", ...extra }) as NodeJS.ProcessEnv;

describe("1. the service probes its own egress, and says what it found", () => {
  const SRC = readFileSync(join(__dirname, "..", "services", "ytdlp-download", "main.py"), "utf8");

  it("the probe asks for metadata only — no bytes, no file", () => {
    const at = SRC.indexOf("def _probe_egress()");
    const body = SRC.slice(at, SRC.indexOf("@app.get(\"/health/egress\")"));
    expect(body).toContain("download=False");
  });

  /**
   * RUN it, do not read it. The first version of this probe called `_ydl_options()` with no
   * arguments — it takes three — and this test asserted the string "_ydl_options()" was present,
   * found it, and passed. Every call to /health/egress raised TypeError and returned 500, which a
   * caller cannot tell apart from a service that is down. A test that reads a call can only prove
   * the call was written, never that it can be made.
   */
  const py = (code: string) => {
    const r = spawnSync("python3", ["-c", code], {
      cwd: join(__dirname, "..", "services", "ytdlp-download"),
      encoding: "utf8",
      timeout: 60_000,
    });
    return r;
  };
  const importable = py("import yt_dlp, fastapi").status === 0;
  const runs = importable ? it : it.skip;

  runs("the probe's options can actually be built — the builder is called correctly", () => {
    const r = py(
      "import main, json; o = main._probe_options(); print(json.dumps(sorted(o.keys())))"
    );
    expect(r.stderr, "building the probe options raised").not.toContain("Error");
    expect(r.status).toBe(0);
    const keys: string[] = JSON.parse(r.stdout.trim());
    expect(keys).toContain("skip_download");

    const v = py("import main; print(main._probe_options()['skip_download'])");
    expect(v.stdout.trim(), "skip_download is set but not to True").toBe("True");
  });

  /**
   * A metadata call must not inherit the format selector or the range hooks, or it can fail for
   * reasons that have nothing to do with egress — and then report a working proxy as blocked.
   */
  runs("it drops the download-only options before asking", () => {
    const r = py("import main, json; print(json.dumps(sorted(main._probe_options().keys())))");
    expect(r.status).toBe(0);
    const keys: string[] = JSON.parse(r.stdout.trim());
    for (const key of ["format", "download_ranges", "force_keyframes_at_cuts", "outtmpl"]) {
      expect(keys, `${key} survived into a metadata-only call`).not.toContain(key);
    }
  });

  /** What it must KEEP: the settings that decide whose network identity is being tested. */
  runs("it keeps the settings that make this a test of the real route", () => {
    const r = py("import main, json; print(json.dumps(sorted(main._probe_options().keys())))");
    const keys: string[] = JSON.parse(r.stdout.trim());
    expect(keys).toContain("js_runtimes");
    expect(keys).toContain("socket_timeout");
  });

  it("it goes through the same options builder a real download uses", () => {
    const body = SRC.slice(SRC.indexOf("def _probe_options()"), SRC.indexOf("def _probe_egress()"));
    expect(body).toContain("_ydl_options(");
  });

  /**
   * The setup is inside the try, not before it. `_probe_options` reads the environment and goes
   * through the shared builder, so it can raise — and the endpoint's whole purpose is to return an
   * answer rather than an error.
   */
  it("a failure to set the probe up is still an answer, not a 500", () => {
    const body = SRC.slice(SRC.indexOf("def _probe_egress()"), SRC.indexOf('@app.get("/health/egress")'));
    const tryAt = body.indexOf("try:");
    expect(tryAt).toBeGreaterThan(0);
    expect(body.indexOf("_probe_options()")).toBeGreaterThan(tryAt);
  });

  it("it never raises — a probe that throws must not stop the service", () => {
    const at = SRC.indexOf("def _probe_egress()");
    const body = SRC.slice(at, SRC.indexOf("@app.get(\"/health/egress\")"));
    expect(body).toContain("except Exception as err");
    expect(SRC).toContain("def _probe_on_boot()");
    expect(SRC.slice(SRC.indexOf("def _probe_on_boot()"))).toContain("except Exception as err");
  });

  /**
   * A platform probes /health every few seconds, and this costs a real request to YouTube.
   * Running it there would turn a health check into rate-limit pressure — making worse exactly
   * the thing it measures.
   */
  it("it is NOT on /health — that endpoint stays free", () => {
    const health = SRC.slice(SRC.indexOf('@app.get("/health")'), SRC.indexOf("def _classify_probe_error"));
    expect(health).not.toContain("_probe_egress()");
    expect(health).toContain("_last_egress");
  });

  it("the proxy URL is never put in a response or a log line", () => {
    expect(SRC).toContain('"proxyConfigured": bool(PROXY_URL)');
    expect(SRC).not.toMatch(/"proxy(Url|URL)":\s*PROXY_URL/);
    expect(SRC).not.toMatch(/logging\.[a-z]+\([^)]*PROXY_URL[^)]*\)/);
  });

  it("the probe video is overridable, so a removal is configuration and not a deploy", () => {
    expect(SRC).toContain('os.environ.get("EGRESS_PROBE_VIDEO_ID"');
  });
});

describe("2. one bot check ends the cloud route for the render", () => {
  beforeEach(() => resetCloudEgressBlocked());

  it("the latch closes once and says which call closed it", () => {
    expect(cloudEgressRefusal()).toBeNull();
    expect(noteCloudEgressBlocked("ynJoy1OCeVQ", "http_502:bot_check")).toBe(true);
    expect(cloudEgressRefusal()).toEqual({ videoId: "ynJoy1OCeVQ", reason: "http_502:bot_check" });
  });

  /** So the caller logs it once, not on every one of 2609 candidates. */
  it("a second bot check does not re-announce it", () => {
    expect(noteCloudEgressBlocked("a", "http_502:bot_check")).toBe(true);
    expect(noteCloudEgressBlocked("b", "http_502:bot_check")).toBe(false);
    expect(cloudEgressRefusal()?.videoId).toBe("a");
  });

  /**
   * An IP's reputation recovers and a proxy gets fixed. A latch that outlived its render would
   * turn a bad hour into a permanent outage.
   */
  it("it is render-scoped and reset with the rest", () => {
    noteCloudEgressBlocked("a", "http_502:bot_check");
    resetCloudEgressBlocked();
    expect(cloudEgressRefusal()).toBeNull();
  });

  const SRC = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

  it("the render resets it where it resets the per-video memo", () => {
    const at = SRC.indexOf("resetPermanentDownloadRefusals();");
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at, at + 400)).toContain("resetCloudEgressBlocked()");
  });

  it("the latch is read before the cloud branch is entered", () => {
    const read = SRC.indexOf("const egressBlocked = cloudEgressRefusal();");
    const call = SRC.indexOf("const dlUrl = `${cloudDlService}/download");
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(call);
    expect(SRC).toContain("if (cloudDlService && !egressBlocked) {");
  });

  /** Skipped, never silent: the attempt still records why it was not made. */
  it("a skipped cloud attempt still says why", () => {
    expect(SRC).toContain('note("cloud", "DOWNLOAD_FAILED", `cloud_egress_blocked:${egressBlocked.reason}`)');
  });

  /** Only a bot check closes it. A refused video is not a refused route. */
  it("only bot_check latches — a per-video refusal does not", () => {
    expect(SRC).toContain('cloudReason.endsWith(":bot_check") && noteCloudEgressBlocked(');
  });

  it("the fallback route is untouched by the latch", () => {
    expect(SRC).toContain("scene_budget_too_short_to_start");
    expect(SRC).not.toContain("if (hasRapidRoute && egressBlocked)");
  });
});

describe("3. the preflight reports what the service answered", () => {
  it("a reachable service is reported as reachable", async () => {
    const host = await checkHost(
      probes({ canReachYoutubeEgress: async () => ({ ok: true }) }),
      YT()
    );
    const row = host.find((h) => h.id === "youtube_egress");
    expect(row?.available).toBe(true);
    expect(row?.detail).toContain("reached YouTube");
  });

  it("a bot-checked service is reported as blocked, and points at the proxy", async () => {
    const host = await checkHost(
      probes({ canReachYoutubeEgress: async () => ({ ok: false, reason: "bot_check" }) }),
      YT()
    );
    const row = host.find((h) => h.id === "youtube_egress");
    expect(row?.available).toBe(false);
    expect(row?.detail).toContain("CANNOT reach YouTube");
    expect(row?.detail).toContain("bot_check");
    expect(row?.detail).toContain("PROXY_URL");
  });

  /**
   * "The service did not answer" and "the service answered that it is blocked" send an operator to
   * two different places, so they may not be flattened into one line.
   */
  it("a service that did not answer is told apart from one that answered no", async () => {
    const host = await checkHost(probes({ canReachYoutubeEgress: async () => null }), YT());
    const row = host.find((h) => h.id === "youtube_egress");
    expect(row?.available).toBe(false);
    expect(row?.detail).toContain("did not answer");
    expect(row?.detail).not.toContain("CANNOT reach YouTube");
  });

  it("a probe that throws is handled, not propagated", async () => {
    const host = await checkHost(
      probes({
        canReachYoutubeEgress: async () => {
          throw new Error("boom");
        },
      }),
      YT()
    );
    expect(host.find((h) => h.id === "youtube_egress")?.available).toBe(false);
  });

  /**
   * A deployment without the cloud service is not failing at anything — the fallback exists and
   * the capability list already says the primary is absent. Reporting "unreachable" there would
   * turn a configuration choice into a fault.
   */
  it("no service configured means the question is not asked at all", async () => {
    const host = await checkHost(
      probes({ canReachYoutubeEgress: async () => ({ ok: false, reason: "bot_check" }) }),
      { DATABASE_URL: "mysql://x" } as NodeJS.ProcessEnv
    );
    expect(host.find((h) => h.id === "youtube_egress")).toBeUndefined();
  });

  it("a caller that supplies no probe still works — the field is optional", async () => {
    const host = await checkHost(probes(), YT());
    expect(host.find((h) => h.id === "youtube_egress")).toBeUndefined();
    expect(host.find((h) => h.id === "ffmpeg")?.available).toBe(true);
  });

  it("the worker supplies the probe, and sends the token without logging it", () => {
    const WORKER = readFileSync(join(__dirname, "worker.ts"), "utf8");
    expect(WORKER).toContain("canReachYoutubeEgress:");
    expect(WORKER).toContain("/health/egress");
    expect(WORKER).toContain("Authorization: `Bearer ${token}`");
    expect(WORKER).not.toMatch(/console\.[a-z]+\([^)]*YOUTUBE_CC_DL_TOKEN/);
  });
});
