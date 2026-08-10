import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { exec, probeVideoDurationSec, withSceneFetchTimeout } from "./videoPipeline";
import { ffmpegSemaphore } from "./_core/semaphore";

// F3-07 findings 3.2 and 3.3: the custom-voiceover branch of _runVideoPipelineInner used to
// (a) probe duration with a handwritten execFile() that had no timeout, no ffmpegSemaphore, and
// a Promise executor that never rejected, and (b) split the audio per scene with a bare exec()
// call that had no timeout wrapper at all — unlike the normal-TTS branch right next to it.
//
// The fix reuses two already-hardened, already-exported building blocks instead of introducing
// new timeout logic: probeVideoDurationSec (already used by every TTS provider, itself built on
// withSceneFetchTimeout + exec()) for (a), and withSceneFetchTimeout(() => exec(...), 45_000,
// label) — the exact composition splitFullVoiceoverByScenes already uses for the equivalent
// per-scene ffmpeg audio split — for (b).
//
// probeVideoDurationSec's own hang-protection timeout (30s) isn't caller-configurable, so
// rather than a real 30-second wait (or mocking child_process's exec internals), the shared
// hang -> hard-kill -> ffmpegSemaphore-released mechanism both call sites now rely on is
// exercised directly here via withSceneFetchTimeout(() => exec(...), <short ms>, label) against
// a real hanging `sleep` process — the same primitive probeVideoDurationSec is built on, just
// with a caller-controlled short timeout so the test stays fast.
describe("custom-voiceover timeout fixes (F3-07)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-f307-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("probeVideoDurationSec returns a real positive duration for a valid audio file", async () => {
    const audioPath = path.join(dir, "voice.mp3");
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -c:a libmp3lame -b:a 64k "${audioPath}"`);

    const duration = await probeVideoDurationSec(audioPath);

    expect(duration).toBeGreaterThan(2.5);
    expect(duration).toBeLessThan(3.5);
  });

  it("probeVideoDurationSec resolves 0 (not a throw/hang) for a corrupt file, matching the || 60 fallback", async () => {
    const badPath = path.join(dir, "not-really-audio.mp3");
    fs.writeFileSync(badPath, Buffer.from("this is not a valid mp3 file"));

    const duration = await probeVideoDurationSec(badPath);

    expect(duration).toBe(0);
    expect(duration || 60).toBe(60); // exact fallback expression now used at the custom-voice call site
  });

  it("withSceneFetchTimeout(exec(...)) hard-kills a hung process and releases the ffmpegSemaphore slot — the mechanism both fixed call sites now rely on", async () => {
    expect(ffmpegSemaphore.active).toBe(0);
    const start = Date.now();

    // A shell-builtin infinite loop (no subprocess spawn) — SIGKILL to the shell itself
    // terminates it immediately, unlike e.g. `sleep 5`, where killing the /bin/sh wrapper
    // orphans the `sleep` grandchild, which keeps the stdout pipe open (and exec()'s callback
    // pending) until it exits on its own. This is the representative "genuinely stuck command"
    // shape for a hung ffmpeg process, which likewise doesn't fork further subprocesses.
    await expect(
      withSceneFetchTimeout(() => exec("while :; do :; done"), 300, "F3-07 hang test")
    ).rejects.toThrow();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000); // killed well before it would ever finish on its own

    // SIGKILL delivery + process reap is a real async OS event — withSceneFetchTimeout's promise
    // rejects the instant the timer fires, but ffmpegSemaphore.run()'s finally() only releases
    // once the killed child's own exit event actually reaches execRaw's callback, a beat later.
    const deadline = Date.now() + 2_000;
    while (ffmpegSemaphore.active > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(ffmpegSemaphore.active).toBe(0); // slot released, not leaked
  });

  it("the same mechanism still succeeds normally for a fast command (custom-voiceover split shape)", async () => {
    const srcPath = path.join(dir, "full.mp3");
    const outPath = path.join(dir, "scene_0.mp3");
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -c:a libmp3lame -b:a 64k "${srcPath}"`);

    await withSceneFetchTimeout(
      () => exec(`ffmpeg -y -i "${srcPath}" -ss 0 -t 1.5 -c copy "${outPath}"`),
      45_000,
      "Custom voiceover split scene 0"
    );

    expect(fs.existsSync(outPath)).toBe(true);
    const dur = await probeVideoDurationSec(outPath);
    expect(dur).toBeGreaterThan(1.0);
  });
});
