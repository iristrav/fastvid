import { describe, expect, it, afterEach, vi } from "vitest";
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

  it("stops immediately once cancellation arises mid-loop, after the first candidate has already started — no further metadata/download calls for later candidates", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-ia-midloop-cancel-test-"));
    mockedFetch
      // Call 1: the query search — returns two candidate docs.
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          response: {
            docs: [
              { identifier: "docA", title: "a" },
              { identifier: "docB", title: "b" },
            ],
          },
        }),
      } as never))
      // Call 2: docA's metadata fetch — cancellation arrives here, mid-loop, exactly like a
      // stall-requeue/explicit cancel firing while the production render was already partway
      // through this scene's Internet Archive search.
      .mockImplementationOnce(async () => {
        requestVideoGenerationCancel(videoId);
        return { ok: false } as never;
      });

    const results = await runWithActiveVideoId(videoId, () =>
      fetchInternetArchiveClips(["some query"], 5, dir, 17, 2)
    );

    expect(results).toEqual([]);
    // Exactly 2 calls: the query search + docA's metadata fetch. docB must never be reached —
    // proves the per-doc loop's cancellation check (not just the function-entry check) is what
    // stops the loop.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
