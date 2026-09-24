/**
 * RONDE 648 — the yt-dlp service prefers 720p instead of the largest stream it is offered.
 *
 * Measured with yt-dlp 2026.08.19's own selector (services/ytdlp-download/check_format_choice.py):
 * the old options picked 2160p from a 144p–2160p ladder, every byte through the paid residential
 * proxy, for a clip scaled into 1920x1080 as B-roll. With `format_sort: res:720` the same ladder
 * yields 720p; with nothing at 720 the largest stream below it; with nothing at or below, the
 * smallest above. The Python check runs the real selector; this pins the options it checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const MAIN = readFileSync(join(__dirname, "..", "services", "ytdlp-download", "main.py"), "utf8");

describe("the service's format options", () => {
  it("prefer a resolution, 720 by default", () => {
    expect(MAIN).toContain('MAX_HEIGHT = int(os.environ.get("MAX_FORMAT_HEIGHT", "720"))');
    expect(MAIN).toContain('"format_sort": [f"res:{MAX_HEIGHT}"],');
  });

  it("keep the 480p floor the client relies on", () => {
    expect(MAIN).toContain('"format": f"bv*[height>={MIN_HEIGHT}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",');
  });

  it("the real-selector check exists beside the service", () => {
    const CHECK = readFileSync(join(__dirname, "..", "services", "ytdlp-download", "check_format_choice.py"), "utf8");
    expect(CHECK).toContain('"v720+a"');
    expect(CHECK).toContain("main._ydl_options(");
  });
});
