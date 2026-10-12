/**
 * VIDEO 649 — THE BUNDLED FFMPEG IS THE BUILD OF CHOICE.
 *
 * The operator's decision: the bundled ffmpeg-static (7.0.2) renders the transition graph the
 * system ffmpeg (Debian 5.1) could not configure in any render since 6 October, and does
 * everything else the pipeline asks the same. The system build is the reserve, and the other
 * build the transition ladder may try. ffprobe is not bundled and stays with the system build.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  alternateFFmpegBin,
  ffmpegVersionLine,
  resolveFFmpegBin,
  staticFFmpegPath,
  SYSTEM_FFMPEG_PATHS,
} from "./ffmpegBinary";

const BINARY = fs.readFileSync(path.join(__dirname, "ffmpegBinary.ts"), "utf8");
const START = fs.readFileSync(path.join(__dirname, "..", "worker-start.sh"), "utf8");
const DOCKERFILE = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");

const bundled = staticFFmpegPath();
const bundledRuns = bundled !== "ffmpeg" && fs.existsSync(bundled) && ffmpegVersionLine(bundled) != null;

describe("the build of choice", () => {
  const saved = process.env.FFMPEG_BIN;
  beforeEach(() => { delete process.env.FFMPEG_BIN; });
  afterEach(() => { if (saved == null) delete process.env.FFMPEG_BIN; else process.env.FFMPEG_BIN = saved; });

  it("the version line names the build, and nothing for a binary that will not run", () => {
    if (bundledRuns) expect(ffmpegVersionLine(bundled)).toMatch(/^ffmpeg version 7\./);
    expect(ffmpegVersionLine("/nonexistent/ffmpeg")).toBeNull();
  });

  it("without FFMPEG_BIN the bundled build is chosen when it runs; a system build is then the alternate", () => {
    if (!bundledRuns) return;
    const chosen = resolveFFmpegBin();
    expect(fs.realpathSync(chosen)).toBe(fs.realpathSync(bundled));
    const system = SYSTEM_FFMPEG_PATHS.find((p) => fs.existsSync(p));
    const alt = alternateFFmpegBin(chosen);
    if (system) {
      expect(alt).not.toBeNull();
      expect(fs.realpathSync(alt!)).not.toBe(fs.realpathSync(bundled));
    }
  });

  it("source order: FFMPEG_BIN, then the bundled build, then the system paths", () => {
    const env = BINARY.indexOf("const envPath = process.env.FFMPEG_BIN");
    const bundledAt = BINARY.indexOf("Using the bundled ffmpeg-static (build of choice)");
    const systemAt = BINARY.indexOf("for (const p of SYSTEM_FFMPEG_PATHS) {\n    if (fs.existsSync(p) && testBinary(p)) {");
    expect(env).toBeGreaterThan(0);
    expect(bundledAt).toBeGreaterThan(env);
    expect(systemAt).toBeGreaterThan(bundledAt);
    /** the old order's reason is gone with it: no build is preferred for drawtext any more */
    expect(BINARY).not.toContain("drawtext-capable");
  });

  it("the worker start script prefers the bundled build, keeps ffprobe with the system, and says which version runs", () => {
    const bundledBlock = START.indexOf('BUNDLED_FFMPEG="$APP_DIR/node_modules/ffmpeg-static/ffmpeg"');
    const pathLookup = START.indexOf('if [ -z "$FFMPEG_PATH" ] && command -v ffmpeg >/dev/null 2>&1; then');
    expect(bundledBlock).toBeGreaterThan(0);
    expect(pathLookup).toBeGreaterThan(bundledBlock);
    expect(START).toContain('if "$BUNDLED_FFMPEG" -version >/dev/null 2>&1; then');
    expect(START).toContain('export FFMPEG_BIN="$FFMPEG_PATH"');
    /** the bundled directory holds no ffprobe, so PATH is not pointed at it */
    expect(START).toContain('if [ "$FFMPEG_PATH" != "$BUNDLED_FFMPEG" ]; then\n    export PATH="$FFMPEG_DIR:$PATH"');
    expect(START).toContain("Using the bundled ffmpeg-static (build of choice)");
  });

  it("the image fetches the bundled build and keeps the system build as the reserve", () => {
    expect(DOCKERFILE).toContain("RUN node node_modules/ffmpeg-static/install.js");
    expect(DOCKERFILE).toContain('|| echo "[Dockerfile] ffmpeg-static binary not fetched — the system ffmpeg is used instead"');
    expect(DOCKERFILE).toContain("RUN ffmpeg -version | head -1");
  });

  it("drawtext — the one filter the bundled build lacks — has no live use in the server code", () => {
    /** ffmpegBinary.ts REPORTS whether a build has drawtext (the start-up capability line); it does not use it. */
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "ffmpegBinary.ts");
    const live: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(__dirname, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (!t.includes("drawtext")) return;
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        live.push(`${f}:${i + 1}`);
      });
    }
    expect(live).toEqual([]);
  });
});
