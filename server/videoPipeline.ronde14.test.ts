import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// RONDE 14 — "why is Wikimedia never downloaded?"
//
// Production logs: every Wikimedia file download was rejected with HTTP 429 (Too Many Requests),
// a few with 403 — so Wikimedia's sourcing metrics showed results=30 but downloads=0, accepted=0.
// Root cause: Wikimedia (upload.wikimedia.org / Commons) enforces a User-Agent policy — requests
// without a descriptive UA are throttled/blocked. The SEARCH requests (scenePool.ts) already send
// "Fastvid/1.0 (...)", which is why search returned results; but the FILE DOWNLOAD in
// downloadAndTrimPoolCandidate sent a bare fetch(url, { signal }) with NO User-Agent header, so
// every Wikimedia download 429'd. Pexels/Pixabay have no such policy, which is why only Wikimedia
// fell over. Fix: send the same User-Agent on the pool-candidate download fetch.

const pipelineSrc = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/** Strips comments so assertions match executable code, not the prose explaining it. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function downloadFnBody(): string {
  const start = pipelineSrc.indexOf("export async function downloadAndTrimPoolCandidate(");
  expect(start).toBeGreaterThan(-1);
  const end = pipelineSrc.indexOf("\nexport ", start + 1);
  return codeOnly(pipelineSrc.slice(start, end === -1 ? undefined : end));
}

describe("RONDE 14 — the pool-candidate download sends a User-Agent (Wikimedia 429 fix)", () => {
  const body = downloadFnBody();

  it("the candidate download fetch includes a User-Agent header", () => {
    // The fetch on candidate.remoteUrl must carry a UA now, not a bare { signal } request.
    const fetchIdx = body.indexOf("fetch(candidate.remoteUrl");
    expect(fetchIdx).toBeGreaterThan(-1);
    const window = body.slice(fetchIdx, fetchIdx + 220);
    expect(window).toContain('"User-Agent"');
    expect(window).toContain("Fastvid/1.0");
  });

  it("the UA is sent alongside the existing abort timeout (not replacing it)", () => {
    const fetchIdx = body.indexOf("fetch(candidate.remoteUrl");
    const window = body.slice(fetchIdx, fetchIdx + 260);
    expect(window).toContain("AbortSignal.timeout(22_000)");
    expect(window).toContain("headers:");
  });

  it("does not embed the operator's personal email in the outbound UA", () => {
    // Reuse the project's existing generic contact, never a user-context email address.
    expect(body).not.toContain("contact@fastvid.tech");
  });
});
