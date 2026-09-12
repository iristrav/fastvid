/**
 * THE CONTRACT NOW LIVES IN TWO LANGUAGES, AND NOTHING MADE THEM AGREE.
 *
 * `downloadYouTubeCCClip` in server/videoPipeline.ts is the client. `services/ytdlp-download/
 * main.py` is the server. They are written in different languages, deployed separately, and
 * changed by different edits — which is precisely the seam this codebase keeps finding:
 *
 *     RONDE 53   recordClipAdopt          one caller of five
 *     RONDE 62   still/moving counters    one caller
 *     RONDE 70   the beat outcome audit   one caller
 *     RONDE 86   failed-asset registration  two routes of five
 *     this session  the vision verdict counter  one route of five
 *
 * Every one of those was a rule two or more places had to remember, and in every one most places
 * did not. A URL shape and a size floor spread across a TypeScript file and a Python file is the
 * same shape of problem, with the added property that the halves cannot even fail to compile
 * together.
 *
 * So the agreement is asserted here, from both files, on the four things that break silently:
 * the path, the query parameters, the auth header, and the size bounds. A drift in any of them
 * produces a service that answers 200 with something FastVid throws away — which looks exactly
 * like YouTube blocking the download.
 *
 * ── What this test cannot do ────────────────────────────────────────────────────────────────
 *
 * It cannot prove the service downloads anything. That needs a real YouTube fetch from a real
 * host, and the outcome depends on the IP the service runs from — see the README on why a
 * datacentre address is the hard part. This pins the handshake, not the network.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const CLIENT = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const SERVICE_DIR = path.join(ROOT, "services", "ytdlp-download");
const SERVICE = fs.readFileSync(path.join(SERVICE_DIR, "main.py"), "utf8");

/* ═══════════════════════ the request ═══════════════════════ */

describe("both halves agree on the request", () => {
  /** The client builds this URL by hand; the service declares the route. */
  it("the path is /download on both sides", () => {
    expect(CLIENT, "the client no longer calls /download").toContain("/download?id=");
    expect(SERVICE, "the service no longer serves /download").toContain('@app.get("/download")');
  });

  /**
   * All three, by name. A parameter the client sends and the service does not declare is silently
   * ignored by FastAPI — so dropping `start` here would return the opening seconds of every video
   * with no error anywhere.
   */
  it.each(["id", "duration", "start"])("the service accepts %s", (param) => {
    expect(CLIENT, `the client stopped sending ${param}`).toContain(`${param}=`);
    expect(SERVICE, `the service does not declare ${param}`).toMatch(
      new RegExp(`\\n\\s*${param}:\\s*\\w+\\s*=\\s*Query\\(`)
    );
  });

  /** The client omits the header when the token is unset, so the service must allow that. */
  it("bearer auth is optional on both sides", () => {
    expect(CLIENT).toContain("Authorization: `Bearer ${cloudDlToken}`");
    expect(CLIENT, "the client no longer omits the header when the token is unset").toContain(
      "cloudDlToken ? { Authorization"
    );
    expect(SERVICE, "the service refuses a token-less pairing the client still supports").toContain(
      "if not SERVICE_TOKEN:"
    );
  });
});

/* ═══════════════════════ the size bounds ═══════════════════════ */

describe("both halves agree on what is an acceptable file", () => {
  /**
   * The floor. Below it the client discards the file as DOWNLOAD_EMPTY, so a service that returns
   * a smaller body has spent a transfer on nothing.
   */
  it("the floor is 10 000 bytes on both sides", () => {
    expect(CLIENT, "the client's size floor moved").toContain("(floor is 10000)");
    expect(SERVICE, "the service's floor no longer matches the client's").toContain(
      "MIN_BYTES = 10_000"
    );
  });

  /** The ceiling, written the same way in both files so a change to one is visible against the other. */
  it("the ceiling is 80 MB on both sides", () => {
    expect(CLIENT).toContain("80 * 1024 * 1024");
    expect(SERVICE).toContain("MAX_BYTES = 80 * 1024 * 1024");
  });

  /** And the service refuses rather than shipping something the client will throw away. */
  it("the service checks both bounds before answering", () => {
    expect(SERVICE).toContain("if size < MIN_BYTES:");
    expect(SERVICE).toContain("if size > MAX_BYTES:");
  });
});

/* ═══════════════════════ an oversized body is a failed cut ═══════════════════════ */

/**
 * THE CEILING WAS A WASTE BIN, AND THE BYTES WERE ALREADY SPENT.
 *
 * This service fetches a RANGE, so a correct answer to a three-second beat is a few megabytes. A
 * body over the ceiling does not mean the footage is too big — it means the range did not bind and
 * the whole source arrived. The check runs after the download, so refusing recovered nothing that
 * was still at stake; it only declined to send on what had already been paid for.
 *
 * Render 575 measured what that costs on another provider against the same 80 MB ceiling: one
 * 92 216 473-byte asset, 111 identical refusals in 164 seconds, while the beat it was for ran out
 * of time and the export gate then refused the scene for having no usable footage.
 *
 * The cut is verified against real ffmpeg rather than asserted here — these tests pin the RULES,
 * which are the half that can drift silently: that the salvage exists, that the ceiling still
 * binds afterwards, and that the ceiling was not quietly raised to make the problem go away.
 */
describe("an over-ceiling body is cut, not discarded", () => {
  const code = SERVICE.replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "");

  it("THE SALVAGE RUNS BEFORE THE BOUNDS ARE ENFORCED", () => {
    const salvage = code.indexOf("_salvage_oversized(produced, work, start, duration, size)");
    const floor = code.indexOf("if size < MIN_BYTES:");
    expect(salvage, "the salvage is gone — an untrimmed body is discarded again").toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(-1);
    expect(salvage, "the bounds are enforced before the cut is attempted").toBeLessThan(floor);
  });

  it("AND THE CEILING STILL BINDS AFTERWARDS — the client does not trim", () => {
    /**
     * The one that would ruin a video silently. `downloadYouTubeCCClip` renames this response
     * straight to the beat's clip file, so a whole video answered at 200 is a whole video in the
     * montage. The salvage may turn a refusal into a clip; it may never turn it into a pass.
     */
    const salvage = code.indexOf("_salvage_oversized(produced, work, start, duration, size)");
    expect(code.slice(salvage)).toContain("if size > MAX_BYTES:");
  });

  it("the ceiling was not raised to make the refusal go away", () => {
    expect(SERVICE).toContain("MAX_BYTES = 80 * 1024 * 1024");
    expect(code, "the ceiling became configurable — the client's is not").not.toMatch(
      /MAX_BYTES\s*=\s*int\(os\.environ/
    );
  });

  it("THE WINDOW IS MEASURED BEFORE IT IS CUT", () => {
    /**
     * Cutting `[start, start+duration]` out of a file that is ALREADY that window would take the
     * wrong seconds — the offset applied twice. So the file's real duration decides, and a body at
     * the requested length is refused exactly as before rather than re-encoded.
     */
    expect(code).toContain("def _probe_duration(");
    expect(code).toContain("if probed <= duration + _SALVAGE_MARGIN_SEC:");
    expect(code).toContain('return produced, size, "already_cut"');
  });

  it("the cut seeks before it decodes", () => {
    // `-ss` BEFORE `-i`: four seconds out of a forty-minute file costs what four seconds cost.
    const args = code.slice(code.indexOf("def _cut_window("), code.indexOf("def _salvage_oversized("));
    expect(args.indexOf('"-ss"')).toBeLessThan(args.indexOf('"-i"'));
  });

  it("EVERY OUTCOME IS NAMED, so a repeated failure can say which one it is", () => {
    for (const outcome of ["salvaged", "already_cut", "cut_failed", "unprobed"]) {
      expect(code, `the ${outcome} case lost its name`).toContain(`"${outcome}"`);
    }
    expect(code, "the refusal does not say whether the cut was tried").toContain("salvage={salvage}");
  });

  it("a failed cut falls through to the refusal rather than raising", () => {
    /** Every helper here answers; none of them can turn a size problem into a 500. */
    const helpers = code.slice(code.indexOf("def _probe_duration("), code.indexOf('@app.get("/health")'));
    expect(helpers).toContain("except Exception:");
    expect(helpers, "a helper raises instead of answering").not.toMatch(/\braise\b/);
  });
});

/* ═══════════════════════ the segment, not the video ═══════════════════════ */

describe("the service returns the already-trimmed segment", () => {
  /**
   * THE ONE THAT WOULD RUIN A VIDEO SILENTLY.
   *
   * The client renames the response straight to the beat's clip file and does not trim again.
   * A service that returned the whole source would put the whole source in the montage, and the
   * render would succeed.
   */
  it("yt-dlp is asked for a range, not a file", () => {
    expect(SERVICE, "the service downloads the whole video — the client will not trim it").toContain(
      "download_ranges"
    );
    expect(SERVICE).toContain("download_range_func(None, [(start, end)])");
  });

  /** Without this the cut lands on the previous keyframe: a frozen or black opening frame. */
  it("the cut is forced onto a keyframe", () => {
    expect(SERVICE).toContain('"force_keyframes_at_cuts": True');
  });

  /** The client's own comment says it renames rather than trims — if that changes, so must this. */
  it("the client still renames the body straight to the clip", () => {
    const at = CLIENT.indexOf("cloudTmpPath");
    expect(at).toBeGreaterThan(-1);
    expect(CLIENT.slice(at, at + 4000)).toContain("fs.renameSync(cloudTmpPath, outPath)");
  });
});

/* ═══════════════════════ it can be deployed at all ═══════════════════════ */

describe("the service is deployable", () => {
  it.each(["main.py", "requirements.txt", "Dockerfile", "README.md"])("ships %s", (file) => {
    expect(fs.existsSync(path.join(SERVICE_DIR, file)), `${file} is missing`).toBe(true);
  });

  /**
   * ffmpeg is not optional: forcing keyframes re-encodes the cut, and the chosen video and audio
   * streams have to be merged. Without it every request fails after the download has been paid for.
   */
  it("the image installs ffmpeg", () => {
    const dockerfile = fs.readFileSync(path.join(SERVICE_DIR, "Dockerfile"), "utf8");
    expect(dockerfile, "ffmpeg is missing — every cut would fail after downloading").toContain("ffmpeg");
  });

  /**
   * THE IMAGE HAD NO JAVASCRIPT RUNTIME AT ALL, AND NOTHING SAID SO.
   *
   * yt-dlp needs a JS runtime to answer YouTube's challenge. Its own help names four — deno,
   * node, quickjs, bun — and says "Only 'deno' is enabled by default". Its Python API confirms
   * the same: `params.get('js_runtimes', {'deno': {}})`.
   *
   * This service runs on `python:3.12-slim`, whose apt line installed ffmpeg and ca-certificates.
   * None of the four was present, and `_ydl_options` passed no `js_runtimes`. So a video that
   * required a challenge could not be fetched under any circumstances — and the failure reads
   * exactly like YouTube refusing the request, which is where a diagnosis goes to die.
   *
   * Verified as far as it can be without the platform: `yt-dlp-ejs` installs from PyPI (0.8.0),
   * yt-dlp 2026.08.19 accepts the parameter with no complaint, and the service answers /health
   * unchanged. That a real challenge is solved needs a route to YouTube and is not proven here.
   */
  it("THE IMAGE INSTALLS A JAVASCRIPT RUNTIME", () => {
    const dockerfile = fs.readFileSync(path.join(SERVICE_DIR, "Dockerfile"), "utf8");
    expect(
      dockerfile,
      "no JS runtime in the image — every YouTube challenge fails and looks like a refusal"
    ).toMatch(/\bnodejs\b|\bdeno\b/);
  });

  it("and the challenge components ship with it, rather than being fetched", () => {
    /**
     * `--remote-components` is "not needed if you are using an official executable or have the
     * requisite version of the yt-dlp-ejs package installed". This service installs yt-dlp from
     * PyPI, so it is neither unless the package is there.
     */
    const reqs = fs.readFileSync(path.join(SERVICE_DIR, "requirements.txt"), "utf8");
    expect(reqs, "yt-dlp-ejs is gone — a challenge can only be answered remotely").toMatch(
      /yt-dlp-ejs>=/
    );
    expect(reqs, "a pinned ejs drifts out of step with yt-dlp").not.toMatch(/yt-dlp-ejs==/);
  });

  it("AND THE RUNTIME IS ENABLED — installing it is not the same as allowing it", () => {
    /**
     * The two halves of this are independent and both are required: apt puts node in the image,
     * and `js_runtimes` is what lets yt-dlp use it, because node is not enabled by default. deno
     * is named too, so an image that later gains the higher-priority runtime uses it with no code
     * change — yt-dlp takes the highest runtime that is both enabled and available.
     */
    expect(SERVICE).toContain('"js_runtimes": {"deno": {}, "node": {}}');
  });

  /** Railway supplies $PORT; a hardcoded port answers nothing. */
  it("it binds the port the platform gives it", () => {
    const dockerfile = fs.readFileSync(path.join(SERVICE_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("${PORT}");
  });

  /**
   * yt-dlp is in a running arms race with YouTube's bot detection. A pinned version works for a
   * few weeks and then downloads nothing, silently — the exact failure mode this whole session
   * has been about.
   */
  it("yt-dlp is not pinned to one version", () => {
    const reqs = fs.readFileSync(path.join(SERVICE_DIR, "requirements.txt"), "utf8");
    expect(reqs).toMatch(/yt-dlp>=/);
    expect(reqs, "a pinned yt-dlp stops working within weeks").not.toMatch(/yt-dlp==/);
  });
});

/* ═══════════════════════ nothing secret is printed ═══════════════════════ */

describe("no credential reaches a log or a response", () => {
  /** A proxy URL carries credentials and an internal hostname; health reports presence only. */
  it("health reports presence, never values", () => {
    const at = SERVICE.indexOf('def health()');
    const body = SERVICE.slice(at, SERVICE.indexOf("@app.get(\"/download\")", at));
    expect(body).toContain('"proxy": bool(PROXY_URL)');
    expect(body, "the proxy URL itself is returned").not.toMatch(/"proxy":\s*PROXY_URL/);
    expect(body, "the service token is returned").not.toContain("SERVICE_TOKEN,");
  });

  it("the success log records whether a proxy was used, not which", () => {
    expect(SERVICE).toContain("proxy=%s");
    expect(SERVICE).toContain("bool(PROXY_URL)");
  });
});
