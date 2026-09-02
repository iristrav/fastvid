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
