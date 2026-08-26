import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// videoPipeline.ts imports fetch from "node-fetch" (a module-scoped binding), not global.fetch —
// so the mock has to replace that import, not globalThis.fetch, for the spy to actually observe
// fetchInternetArchiveClips's calls. Same vi.mock-before-import convention as
// curatedMediaSourcing.f310Streaming.test.ts's storageGetSignedUrl mock.
vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetchMock from "node-fetch";
import { fetchInternetArchiveClips } from "./videoPipeline";
import {
  requestVideoGenerationCancel,
  clearVideoGenerationCancel,
  runWithActiveVideoId,
} from "./videoGenerationCancel";

/**
 * RONDE 90 — this file calls provider fetchers directly, outside any beat.
 *
 * In production every provider search runs inside a beat's provenance scope
 * (withSearchProvenance), and that scope is what lets the gate verify a query against what the
 * script actually says. A direct call has no such scope, so strict mode refuses it — correctly,
 * and by design: a query nobody can trace is exactly what RONDE 90 exists to stop.
 *
 * That refusal is not what this file is about. Its subject is what happens AFTER a query is
 * admitted — the render-scoped query cache, the per-item licence gates, the dedup skips, the call
 * ceilings. The gate's own behaviour, including the refusal above, is covered by
 * ronde89ProviderGate and ronde90SearchProvenance; restating it in every assertion here would
 * test the gate twice and these mechanics not at all.
 */
// Set at module scope, not in beforeAll: several suites here snapshot `process.env` into an
// ORIGINAL_ENV constant while the file is being evaluated and restore it before every test, so a
// value written later is wiped again before the first assertion runs.
process.env.SEARCH_GATE_STRICT = "false";


const mockedFetch = vi.mocked(fetchMock);

// Production fix: fetchInternetArchiveClips's per-query/per-doc try/catch treated a cancellation
// error from trimRemoteVideoToClip exactly like any other single-candidate failure (a bad size, a
// timeout, a 404) and simply moved on to the next candidate. A Railway production log showed the
// resulting waste directly: the same scene's Internet Archive search kept retrying — 88 failed
// attempts over 18 minutes, including 13 retries of the exact same already-failing item — after the
// owning render had already been cancelled/superseded, instead of stopping once cancellation was
// first observed. fetchInternetArchiveClips now checks cancellation before doing any further
// search/download/trim work, at function entry and at the top of both loops.
//
// fetch is mocked purely to prove no network calls happen once cancelled — the actual cancellation
// check exercised here is the real, unmocked isVideoGenerationCancelRequested()/getActiveVideoId()
// path.
describe("fetchInternetArchiveClips cancellation short-circuit (production fix)", () => {
  const videoId = 999102;
  let dir: string;

  afterEach(() => {
    clearVideoGenerationCancel(videoId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    mockedFetch.mockReset();
  });

  it("makes zero network calls and returns immediately once the active render has been cancelled", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ia-cancel-test-"));
    mockedFetch.mockRejectedValue(new Error("fetch should not have been called"));
    requestVideoGenerationCancel(videoId);

    const results = await runWithActiveVideoId(videoId, () =>
      fetchInternetArchiveClips(["some query"], 5, dir, 17, 2)
    );

    expect(results).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("still searches normally when the render has not been cancelled — no regression to the existing search/fallback behavior", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ia-normal-test-"));
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: { docs: [] } }),
    } as never);

    const results = await runWithActiveVideoId(videoId, () =>
      fetchInternetArchiveClips(["some query"], 5, dir, 17, 2)
    );

    expect(results).toEqual([]);
    expect(mockedFetch).toHaveBeenCalled();
  });

  it("stops at batch granularity once cancellation arises mid-loop — the NEXT batch's candidates are never reached", async () => {
    // RONDE 15: Internet Archive metadata is now resolved a batch (IA_METADATA_BATCH=4) at a time
    // concurrently instead of one doc at a time, so cancellation short-circuits at batch
    // granularity, not per-doc: the ≤4 metadata calls already in flight for the current batch may
    // complete, but the loop breaks before the next batch — which is what still prevents the
    // 88-attempt/18-minute churn the original cancellation fix targeted. Here 5 docs span two
    // batches (4 + 1); cancellation fires during the first batch, so the 5th doc (the second
    // batch) is never fetched.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ia-midloop-cancel-test-"));
    const metadataUrlsFetched: string[] = [];
    mockedFetch
      // Call 1: the query search — returns five candidate docs (two batches: docA-D, then docE).
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          response: {
            docs: [
              { identifier: "docA", title: "a" },
              { identifier: "docB", title: "b" },
              { identifier: "docC", title: "c" },
              { identifier: "docD", title: "d" },
              { identifier: "docE", title: "e" },
            ],
          },
        }),
      } as never))
      // Every subsequent call is a metadata fetch. The first one fires cancellation, exactly like
      // a stall-requeue/explicit cancel firing partway through this scene's Internet Archive search.
      .mockImplementation(async (url: string) => {
        metadataUrlsFetched.push(String(url));
        requestVideoGenerationCancel(videoId);
        return { ok: false } as never;
      });

    const results = await runWithActiveVideoId(videoId, () =>
      fetchInternetArchiveClips(["some query"], 5, dir, 17, 2)
    );

    expect(results).toEqual([]);
    // docE is in the SECOND batch — cancellation during the first batch must stop the loop before
    // it. The first batch's ≤4 concurrent metadata calls may complete, but nothing from batch 2.
    expect(metadataUrlsFetched.some((u) => u.includes("docE"))).toBe(false);
    // And the whole thing is bounded: 1 search + at most the first batch's 4 metadata calls.
    expect(mockedFetch.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
