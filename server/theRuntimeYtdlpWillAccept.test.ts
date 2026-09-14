/**
 * A RUNTIME THAT IS INSTALLED IS NOT A RUNTIME THAT IS USED.
 *
 * The image installed `nodejs` from Debian's archive, which ships 18.20 (bookworm) or 20.19
 * (trixie). yt-dlp's floor is higher:
 *
 *     yt_dlp/utils/_jsruntime.py:120   NodeJsRuntime.MIN_SUPPORTED_VERSION = (22, 0, 0)
 *
 * So yt-dlp found node, rejected it, and fell back to the JS-less client set —
 * extractor/youtube/_video.py:2973 picks `_DEFAULT_JSLESS_CLIENTS = ('visionos',)` over
 * `_DEFAULT_CLIENTS = ('visionos', 'web')` when no supported runtime is available. Measured
 * against the installed yt-dlp 2026.08.19, with the service's own js_runtimes option:
 *
 *     node 20.20.2  supported=False  js_runtime_available=False  clients=['visionos']
 *     node 22.22.2  supported=True   js_runtime_available=True   clients=['visionos','web']
 *
 * Every client needing the JS player — web, mweb, tv, tv_simply, web_embedded, web_music,
 * web_safari — was unreachable in production for as long as that held, whatever the network or the
 * PO tokens looked like. It was invisible because yt-dlp reports it through `report_warning`, and
 * main.py sets `no_warnings: True` without `verbose`, which makes that call a no-op.
 *
 * This pins the version floor and the install location. Both are load-bearing and neither is
 * checked anywhere else.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const DOCKERFILE = readFileSync(
  join(__dirname, "..", "services", "ytdlp-download", "Dockerfile"),
  "utf8"
);

/** yt-dlp 2026.08.19, utils/_jsruntime.py:120. Raise this only when yt-dlp raises it. */
const YTDLP_NODE_FLOOR = 22;

describe("the image installs a node yt-dlp will accept", () => {
  it("pins an exact node version at or above yt-dlp's floor", () => {
    const pin = /ARG NODE_VERSION=(\d+)\.(\d+)\.(\d+)\s*$/m.exec(DOCKERFILE);
    expect(pin, "NODE_VERSION is not pinned to an exact x.y.z version").not.toBeNull();
    expect(Number(pin![1])).toBeGreaterThanOrEqual(YTDLP_NODE_FLOOR);
  });

  /**
   * Debian's package is the defect this replaces. Installing it again — under any of its names —
   * puts a rejected runtime back on the image.
   */
  it("does not install node from the distribution's archive", () => {
    const aptLines = DOCKERFILE.split("\n").filter((l) => l.includes("apt-get install"));
    expect(aptLines.length).toBeGreaterThan(0);
    for (const line of aptLines) {
      expect(line, "apt is installing node again").not.toMatch(/\bnodejs?\b/);
    }
  });

  /**
   * yt-dlp's `_find_exe` looks in Python's scripts directory (/usr/local/bin on this base) BEFORE
   * falling back to PATH. A newer node installed elsewhere and put first on PATH is ignored —
   * measured, with yt-dlp still reporting node-20.20.2 while node 22 led PATH. So the unpack
   * target is part of the fix, not a detail.
   */
  it("unpacks into /usr/local, where yt-dlp looks first", () => {
    expect(DOCKERFILE).toMatch(/tar -xJf[^\n]*-C \/usr\/local[^\n]*--strip-components=1/);
  });

  /** The archive is checked against a published digest: an unverified download can change under us. */
  it("verifies the download against a pinned checksum", () => {
    expect(DOCKERFILE).toMatch(/ARG NODE_SHA256=[0-9a-f]{64}\s*$/m);
    expect(DOCKERFILE).toContain("sha256sum -c -");
  });

  /** A build that produces the wrong runtime must fail at build time, not at render time. */
  it("fails the build if the installed runtime is below the floor", () => {
    expect(DOCKERFILE).toMatch(/node --version/);
    expect(DOCKERFILE).toContain("process.exit(1)");
  });
});
