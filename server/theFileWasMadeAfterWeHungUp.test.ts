/**
 * THE FILE WAS MADE — AFTER WE HUNG UP. RONDE 642.
 *
 * Render 603, the yt-dlp service's access log against its own application log:
 *
 *     14:34:58  GET /download?id=yOPuuSeBfyo…  → 499 after 14.9 s   (FastVid closed the connection)
 *     14:35:28  INFO ok id=yOPuuSeBfyo start=4.50 dur=4.00 bytes=1592852
 *
 * 13 of 17 cloud requests ended 499; the service finished each cut seconds later and deleted it.
 * The render then asked for the same id and start again — OwwcdkV30U8 five times — paying ~30 s
 * each time. The service now keeps a finished cut and coalesces identical requests; the behaviour
 * itself is exercised against the real FastAPI app by services/ytdlp-download/check_result_cache.py.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const MAIN = readFileSync(join(__dirname, "..", "services", "ytdlp-download", "main.py"), "utf8");

describe("the service keeps what it made", () => {
  it("a finished cut is stored BEFORE the response goes out, so a hung-up caller does not lose it", () => {
    const store = MAIN.indexOf("produced = _store_result(key, produced)");
    const respond = MAIN.indexOf("return FileResponse(\n        produced,");
    expect(store).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(store);
  });

  it("a repeat ask is answered from the kept result, and says so", () => {
    expect(MAIN).toContain("hit = _cached_result(key)");
    expect(MAIN).toContain("cached=hit");
  });

  it("an identical request in flight is waited for, not started twice", () => {
    expect(MAIN).toContain("running.wait(timeout=INFLIGHT_WAIT_S)");
    expect(MAIN).toMatch(/INFLIGHT_WAIT_S = 150\b/);
  });

  it("kept for a bounded time and a bounded size", () => {
    expect(MAIN).toContain("RESULT_TTL_S = 30 * 60");
    expect(MAIN).toContain('RESULT_CACHE_MB", "1024"');
  });

  it("the key is the whole request — a different start is a different cut", () => {
    expect(MAIN).toContain('return f"{safe}_{start:.2f}_{duration:.2f}"');
  });
});
