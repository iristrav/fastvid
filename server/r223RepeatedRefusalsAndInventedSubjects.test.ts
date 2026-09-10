/**
 * RONDE 223 — WHAT RENDER 575 (rmtulyr50) SPENT ITS EIGHTEEN MINUTES ON.
 *
 * The render failed with `Scene 1: 6 zinnen maar 0 voice/script-matchende clips — export
 * geblokkeerd`, and the export gate was right: there was no footage. This file is about where the
 * time went instead, measured from that render's own log.
 *
 * ── 1. One file, refused 108 times ─────────────────────────────────────────────────────────
 *
 *     Content-Length: 92216473        111 identical refusals
 *     cap:            83886080        164 seconds, ~one request every 1.5s
 *     108 of them on "Pixabay download scene 1 clip 2" alone
 *
 * The size is in the header before a byte is transferred, so the refusal is a fact about the FILE.
 * An inner loop of three attempts, wrapped by a candidate loop that handed back the same URL some
 * thirty-six times, and neither could see the other. The rule that stops this already existed and
 * ran in the same render — `[RetryGuard] … retryable=false action=SKIP reason=NOT_RETRYABLE` — and
 * the download path had never registered with it.
 *
 * ── 2. Queries that could never be queries ─────────────────────────────────────────────────
 *
 *     query="documentary"  reason=NO_CONTENT_ANCHOR   × 80
 *     query="establishing" reason=NO_CONTENT_ANCHOR   × 74
 *     query="street"       reason=UNVERIFIED_TERM     × 76
 *     query="germany"      reason=UNVERIFIED_TERM     × 74
 *     query="government"   reason=UNVERIFIED_TERM     × 72
 *
 * Two different sources, and the reason codes tell them apart. The first pair are production
 * words invented as stand-ins for a missing subject. The second are content words the model wrote
 * that the script cannot prove — `searchTiersSource` was written to mark exactly that and was
 * never once read.
 *
 * NOTHING HERE LOOSENS A GATE. Every term this round stops building is a term the gate already
 * refused; the saving is the building, the sending, the refusing and the logging of it.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  classifyProviderFailure,
  formatPermanentDownloadRefusals,
  isOversizedResponseError,
  isRetryableFailure,
  notePermanentDownloadRefusal,
  permanentDownloadRefusal,
  permanentDownloadRefusalStats,
  resetPermanentDownloadRefusals,
} from "./providerFailureClass";
import { hasContentAnchor, termProvableFrom } from "./searchQueryContract";
import { stubPowerWordFromSceneText } from "./curatedMediaSourcing";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const SEM = fs.readFileSync(path.join(__dirname, "semanticVisualMatching.ts"), "utf8");
const CURATED = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
const FUNNEL = fs.readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");

/* ═══════════ 1. an oversized file is permanently refused ═══════════ */

describe("R223 §1 — the refusal is classified for what it is", () => {
  const REAL = new Error(
    "Pixabay download scene 1 clip 2 attempt 1: response exceeds maximum size of 83886080 bytes (Content-Length: 92216473)"
  );

  it("RENDER 575'S ACTUAL MESSAGE IS RECOGNISED", () => {
    expect(isOversizedResponseError(REAL)).toBe(true);
  });

  it("the streaming spelling is recognised too", () => {
    expect(
      isOversizedResponseError(new Error("x: response exceeded maximum size of 83886080 bytes"))
    ).toBe(true);
  });

  it("IT IS PERMANENT, AND THEREFORE NOT WORTH ASKING AGAIN", () => {
    expect(classifyProviderFailure({ err: REAL })).toBe("PERMANENT");
    expect(isRetryableFailure(classifyProviderFailure({ err: REAL }))).toBe(false);
  });

  it("a 200 status does not talk it out of that — our own code threw after the response was fine", () => {
    expect(classifyProviderFailure({ err: REAL, status: 200 })).toBe("PERMANENT");
  });

  it("ordinary failures are untouched", () => {
    expect(classifyProviderFailure({ err: new Error("socket hang up") })).toBe("RETRYABLE");
    expect(classifyProviderFailure({ err: new Error("request timed out") })).toBe("TIMEOUT");
    expect(classifyProviderFailure({ status: 429 })).toBe("RATE_LIMITED");
    expect(isOversizedResponseError(new Error("some other failure"))).toBe(false);
    expect(isOversizedResponseError(null)).toBe(false);
  });
});

/* ═══════════ 2. the memo, measured ═══════════ */

describe("R223 §2 — the same URL is not fetched twice to be refused twice", () => {
  it("THE SECOND REQUEST IS NOT MADE, AND THE REASON IS KEPT", () => {
    resetPermanentDownloadRefusals();
    const url = "https://cdn.pixabay.com/vid/2019/01/01/huge.mp4";
    expect(permanentDownloadRefusal(url)).toBeNull();
    notePermanentDownloadRefusal(url, "response exceeds maximum size of 83886080 bytes");
    expect(permanentDownloadRefusal(url)).toContain("exceeds maximum size");
  });

  it("MEASURED AGAINST RENDER 575: 108 attempts become 1", () => {
    resetPermanentDownloadRefusals();
    const url = "https://cdn.pixabay.com/vid/scene1clip2.mp4";
    let realRequests = 0;
    for (let i = 0; i < 108; i++) {
      if (permanentDownloadRefusal(url)) continue;
      realRequests++;
      notePermanentDownloadRefusal(url, "response exceeds maximum size of 83886080 bytes");
    }
    expect(realRequests, "the memo did not stop the repeats").toBe(1);
    expect(permanentDownloadRefusalStats().prevented).toBe(107);
  });

  it("a different URL is unaffected — this is per asset, not a provider stand-down", () => {
    resetPermanentDownloadRefusals();
    notePermanentDownloadRefusal("https://a/one.mp4", "too big");
    expect(permanentDownloadRefusal("https://a/two.mp4")).toBeNull();
  });

  it("the first reason wins, so the log does not drift", () => {
    resetPermanentDownloadRefusals();
    notePermanentDownloadRefusal("https://a/x.mp4", "first reason");
    notePermanentDownloadRefusal("https://a/x.mp4", "second reason");
    expect(permanentDownloadRefusal("https://a/x.mp4")).toBe("first reason");
  });

  it("THE NEXT RENDER ASKS AGAIN — a provider may replace its file", () => {
    resetPermanentDownloadRefusals();
    notePermanentDownloadRefusal("https://a/x.mp4", "too big");
    resetPermanentDownloadRefusals();
    expect(permanentDownloadRefusal("https://a/x.mp4")).toBeNull();
    expect(permanentDownloadRefusalStats()).toEqual({ refused: 0, prevented: 0 });
  });

  it("a healthy render prints nothing at all", () => {
    resetPermanentDownloadRefusals();
    expect(formatPermanentDownloadRefusals()).toBeNull();
  });

  it("and a render that hit this fault says what it saved", () => {
    resetPermanentDownloadRefusals();
    notePermanentDownloadRefusal("https://a/x.mp4", "too big");
    permanentDownloadRefusal("https://a/x.mp4");
    expect(formatPermanentDownloadRefusals()).toContain("[DownloadRefusals]");
    expect(formatPermanentDownloadRefusals()).toContain("1 repeat request(s) not made");
  });
});

/* ═══════════ 3. wired at the one place every download passes ═══════════ */

describe("R223 §3 — the choke point, not the loops", () => {
  it("THE MEMO IS CONSULTED BEFORE THE NETWORK", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("export async function downloadToFileStreaming("),
      PIPE.indexOf("async function downloadToFileStreamingInner(")
    );
    expect(fn).toContain("permanentDownloadRefusal(url)");
    const check = fn.indexOf("permanentDownloadRefusal(url)");
    const fetch = fn.indexOf("withGlobalMediaFetch(");
    expect(check, "the request goes out before the memo is read").toBeLessThan(fetch);
  });

  it("a permanent failure is recorded there too", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("export async function downloadToFileStreaming("),
      PIPE.indexOf("async function downloadToFileStreamingInner(")
    );
    expect(fn).toContain(`classifyProviderFailure({ err }) === "PERMANENT"`);
    expect(fn).toContain("notePermanentDownloadRefusal(url,");
  });

  it("THE ERROR STILL THROWS, so every existing catch behaves as before", () => {
    const fn = PIPE.slice(
      PIPE.indexOf("export async function downloadToFileStreaming("),
      PIPE.indexOf("async function downloadToFileStreamingInner(")
    );
    expect(fn).toContain("throw new Error(");
    expect(fn).toContain("throw err;");
  });

  it("NO RETRY LOOP WAS EDITED — the rule is registered once, not scattered", () => {
    /**
     * The defect this codebase keeps removing is a rule N routes must follow, registered by a few.
     * The fix must not itself become one: no download loop gained its own size check.
     */
    expect((PIPE.match(/notePermanentDownloadRefusal\(/g) ?? []).length).toBe(1);
    expect((PIPE.match(/permanentDownloadRefusal\(url\)/g) ?? []).length).toBe(1);
  });

  it("the memo is cleared when a render starts, beside the overlay budget", () => {
    const at = PIPE.indexOf("resetOverlayBudget();");
    expect(PIPE.slice(at, at + 600)).toContain("resetPermanentDownloadRefusals();");
  });
});

/* ═══════════ 4. the model's words are held to the script ═══════════ */

describe("R223 §4 — searchTiersSource is finally read", () => {
  it("THE MARKER HAS A READER NOW", () => {
    expect(SEM, "searchTiersSource is still written and never read").toContain(
      `profile.searchTiersSource === "llm"`
    );
  });

  it("model-written tiers must be provable from the beat", () => {
    const at = SEM.indexOf("const tiersAreModelWritten");
    const block = SEM.slice(at, at + 400);
    expect(block).toContain("termProvableFrom(term, profile.beatText)");
  });

  it("THE BEAT-DERIVED PATH IS UNTOUCHED", () => {
    const at = SEM.indexOf("const tiersAreModelWritten");
    const block = SEM.slice(at, at + 400);
    expect(block, "the filter was applied to the script's own terms too").toContain(
      "tiersAreModelWritten &&"
    );
  });

  it("MEASURED: render 575's three refused terms fail the test, and the real ones pass", () => {
    const beat = "Hitler stayed in the bunker beneath Berlin as the Red Army closed in.";
    for (const refused of ["street", "germany", "government"]) {
      expect(termProvableFrom(refused, beat), `${refused} would still be sent`).toBe(false);
    }
    for (const kept of ["bunker", "hitler", "berlin"]) {
      expect(termProvableFrom(kept, beat), `${kept} was lost`).toBe(true);
    }
  });

  it("the sibling guard RONDE 91 added is still there — this round matched it, not replaced it", () => {
    expect(SEM).toContain(`if (profile.summarySource !== "llm") push(profile.summary);`);
  });
});

/* ═══════════ 5. no subject means no query ═══════════ */

describe("R223 §5 — the genre word stops standing in for a subject", () => {
  it("THE GATE PROVES THESE COULD NEVER HAVE WORKED", () => {
    expect(hasContentAnchor("documentary")).toBe(false);
    expect(hasContentAnchor("establishing")).toBe(false);
  });

  it("A SCENE WITH NO USABLE WORD YIELDS NO POWER WORD", () => {
    expect(stubPowerWordFromSceneText("")).toBe("");
    expect(stubPowerWordFromSceneText("a of to the and")).toBe("");
  });

  it("a scene with a real subject still yields it", () => {
    expect(stubPowerWordFromSceneText("The bunker beneath Berlin").toLowerCase()).toBeTruthy();
  });

  it("none of the three fallbacks invent the genre word any more", () => {
    expect(CURATED, "the archive pool stub still invents a subject").not.toContain(
      `|| "documentary",`
    );
    expect(CURATED).not.toContain(`: ["documentary"]`);
    expect(CURATED).toContain("return best;");
    expect(FUNNEL, "the funnel stub still invents a subject").not.toContain(`|| "documentary"`);
  });

  it("an empty scene is announced rather than papered over", () => {
    expect(CURATED).toContain("[CuratedSourcing] scene text is empty");
  });

  it("`words[0]` is kept — a weak real word beats an invented one", () => {
    const at = FUNNEL.indexOf("powerWord: stubPowerWordFromSceneText(");
    expect(FUNNEL.slice(at, at + 160)).toContain("words[0]");
  });

  it("RONDE 88A's downstream guard still stands — this round fixed the source, not it", () => {
    const heal = fs.readFileSync(path.join(__dirname, "pipelineSelfHeal.ts"), "utf8");
    expect(heal).toContain("if (!hasContentAnchor(q)) return [];");
  });
});
