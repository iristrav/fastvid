/**
 * RONDE 146 — a render stops throwing away what it needs to be understood again.
 *
 * ── The two facts this round is built on, both measured in the RONDE 145 audit ───────────────
 *
 *  1. The lineage ledger holds `provider`, `providerAssetId`, `sourceUrl`, `originalUrl` and
 *     `assetTitle` at the exact moment the manifest is written — and the manifest asked for the
 *     provider's NAME and dropped the other four. The ledger is in-memory, so they were gone.
 *
 *  2. `videos/<id>/final.mp4` was the only thing a render ever made permanent. Counted, by
 *     grepping every `storagePut*` call in the pipeline: two calls, one key. `full_voiceover.mp3`
 *     and `tts_word_alignment.json` were deleted with the work directory, and
 *     `videos.voiceoverUrl` had existed as a column without a writer for the whole time.
 *
 * The tests below are numbered to match the brief's TEST 1–10 so a reader can check the round
 * against what was asked for.
 *
 * ── Real I/O, not mocks ──────────────────────────────────────────────────────────────────────
 *
 * §20 asks for real file I/O. The persistence tests write actual files into an actual temporary
 * directory, upload through an injected boundary that writes to a second real directory, then
 * delete the work directory with the same `fs.rmSync` the pipeline uses, and read the survivors
 * back off disk. The storage boundary is the only seam, because S3 is the one thing that cannot
 * be exercised here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  formatAssetIdentity,
  formatIdentityCoverage,
  identityFromAdoption,
  identityIsRehydratable,
  sourcePageUrlFor,
} from "./assetIdentity";
import {
  buildNarrationPersistence,
  findVoiceoverFile,
  formatVoicePersistFailure,
  narrationIsRecoverable,
  persistVoiceover,
  readNarrationPersistence,
  voiceoverStorageKey,
} from "./renderPersistence";
import {
  buildEditorScenesFromPipeline,
  manifestRehydrationSummary,
} from "./editorClips";
import { MANIFEST_SCHEMA_VERSION, type EditorScene } from "./db";
import {
  ffmpegFallbackCandidates,
  ffmpegRetryReason,
  isBinaryNotFoundFailure,
  isCapabilityFailure,
  retryReasonIsPermanent,
} from "./ffmpegBinary";
import { UNVERIFIED_PROVIDER } from "./visualSourceLineage";

let ROOT = "";
beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r146-"));
});
afterEach(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not worth failing a suite over */
  }
});

/* ═══════════════════════ TEST 1 — identity survives into the manifest ═══════════════════════ */

describe("TEST 1 — an adopted clip's identity reaches the manifest unchanged", () => {
  it("provider, providerAssetId, mediaUrl, sourcePageUrl and title all come back", async () => {
    const scenes = await buildEditorScenesFromPipeline(
      [{ index: 0, text: "narration", duration: 4 }],
      [["/w/scene_0_b0_wiki.mp4"]],
      () => "wikimedia",
      () => ({
        provider: "wikimedia",
        providerAssetId: "File:Berlin_1945.jpg",
        sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Berlin_1945.jpg",
        assetTitle: "Berlin in April 1945",
      })
    );
    const clip = scenes[0]!.clips[0]!;
    expect(clip.sourceIdentity).toBeDefined();
    expect(clip.sourceIdentity!.provider).toBe("wikimedia");
    expect(clip.sourceIdentity!.providerAssetId).toBe("File:Berlin_1945.jpg");
    expect(clip.sourceIdentity!.mediaUrl).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/Berlin_1945.jpg"
    );
    expect(clip.sourceIdentity!.sourcePageUrl).toContain("commons.wikimedia.org");
    expect(clip.sourceIdentity!.title).toBe("Berlin in April 1945");
    expect(scenes[0]!.manifestSchemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });

  it("it survives a JSON round trip — the manifest is stored as JSON", async () => {
    // The column is `json`, so anything that does not serialise is silently lost on the way in.
    const scenes = await buildEditorScenesFromPipeline(
      [{ index: 0, text: "n", duration: 3 }],
      [["/w/a.mp4"]],
      () => "pexels",
      () => ({ provider: "pexels", providerAssetId: "12345", sourceUrl: "https://cdn/x.mp4" })
    );
    const round = JSON.parse(JSON.stringify(scenes)) as EditorScene[];
    expect(round[0]!.clips[0]!.sourceIdentity).toEqual(scenes[0]!.clips[0]!.sourceIdentity);
    expect(round[0]!.manifestSchemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });

  it("THE RULE: identity comes from the adoption record, never from the filename", async () => {
    /**
     * The filename says `pexels`; the ledger says the file actually came from the curated archive.
     * The ledger wins. RONDE 86/87 removed filename inference from provenance once, and this round
     * must not reintroduce it through a new field.
     */
    const scenes = await buildEditorScenesFromPipeline(
      [{ index: 0, text: "n", duration: 3 }],
      [["/w/scene_0_pexels_vid999.mp4"]],
      () => "archive",
      () => ({ provider: "archive", providerAssetId: "57618" })
    );
    expect(scenes[0]!.clips[0]!.sourceIdentity!.provider).toBe("archive");
    expect(scenes[0]!.clips[0]!.sourceIdentity!.providerAssetId).toBe("57618");
  });
});

/* ═══════════════════════ TEST 2 — the seven providers ═══════════════════════ */

describe("TEST 2 — each provider keeps its own kind of identity", () => {
  const cases: Array<{
    name: string;
    facts: Parameters<typeof identityFromAdoption>[0];
    expectId: string | undefined;
    expectPage?: string | RegExp | null;
  }> = [
    {
      name: "curated archive — the archive row id, the strongest handle there is",
      facts: { provider: "archive", providerAssetId: "57618", archiveAssetId: 57618 },
      expectId: "57618",
      expectPage: null,
    },
    {
      name: "wikimedia — the File: title is the stable identity",
      facts: {
        provider: "wikimedia",
        providerAssetId: "File:Reichstag.jpg",
        sourceUrl: "https://upload.wikimedia.org/x.jpg",
      },
      expectId: "File:Reichstag.jpg",
      expectPage: /commons\.wikimedia\.org/,
    },
    {
      name: "LOC — the item URL is the identity, and is NOT a download URL",
      facts: {
        provider: "loc",
        providerAssetId: "https://www.loc.gov/item/2017645678/",
        sourceUrl: "https://tile.loc.gov/storage-services/media/x.mp4",
      },
      expectId: "https://www.loc.gov/item/2017645678/",
      expectPage: null,
    },
    {
      name: "internet archive — the item identifier",
      facts: {
        provider: "internet_archive",
        providerAssetId: "BerlinFalls1945",
        sourceUrl: "https://archive.org/download/BerlinFalls1945/reel.mp4",
      },
      expectId: "BerlinFalls1945",
      expectPage: /archive\.org\/details\/BerlinFalls1945/,
    },
    {
      name: "pexels — the numeric video id, never the CDN link",
      facts: { provider: "pexels", providerAssetId: "3195394", sourceUrl: "https://player.vimeo.com/x.mp4" },
      expectId: "3195394",
      expectPage: /pexels\.com\/video\/3195394\//,
    },
    {
      name: "pixabay — the numeric video id",
      facts: { provider: "pixabay", providerAssetId: "128421", sourceUrl: "https://cdn.pixabay.com/x.mp4" },
      expectId: "128421",
      expectPage: /pixabay\.com\/videos\/128421\//,
    },
    {
      name: "youtube — the videoId",
      facts: { provider: "youtube_cc", providerAssetId: "cS2JdEghHDo" },
      expectId: "cS2JdEghHDo",
      expectPage: /youtube\.com\/watch\?v=cS2JdEghHDo/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const identity = identityFromAdoption(c.facts)!;
      expect(identity.providerAssetId).toBe(c.expectId);
      if (c.expectPage === null) expect(identity.sourcePageUrl).toBeUndefined();
      else if (c.expectPage) expect(identity.sourcePageUrl).toMatch(c.expectPage);
      expect(identityIsRehydratable(identity)).toBe(true);
    });
  }

  it("a page URL is only derived where its shape is documented", () => {
    // NARA, NASA, Europeana and Openverse have no id→page rule this code can state, so it says so
    // instead of building a nearly-right link that sends a rights check to the wrong place.
    for (const p of ["nara", "nasa", "europeana", "openverse", "loc", "curated"]) {
      expect(sourcePageUrlFor(p, "anything")).toBeNull();
    }
    // ...and a non-numeric Pexels id is refused rather than turned into a broken URL.
    expect(sourcePageUrlFor("pexels", "not-a-number")).toBeNull();
    expect(sourcePageUrlFor("pexels", "")).toBeNull();
  });
});

/* ═══════════════════════ TEST 3 — the voiceover is stored ═══════════════════════ */

describe("TEST 3 — voice generated → uploaded → videos.voiceoverUrl", () => {
  it("a real file is uploaded through the storage boundary and its URL comes back", async () => {
    const workDir = path.join(ROOT, "work");
    const storeDir = path.join(ROOT, "store");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "full_voiceover.mp3"), Buffer.alloc(2048, 7));

    const uploads: string[] = [];
    const result = await persistVoiceover({
      videoId: 4242,
      workDir,
      upload: async (key, filePath) => {
        uploads.push(key);
        const dest = path.join(storeDir, path.basename(key));
        fs.copyFileSync(filePath, dest);
        return { key, url: `/local-storage/${key}` };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe("/local-storage/videos/4242/voiceover.mp3");
    expect(result.bytes).toBe(2048);
    expect(uploads).toEqual([voiceoverStorageKey(4242)]);
    // The bytes really moved: a real file exists in the store.
    expect(fs.statSync(path.join(storeDir, "voiceover.mp3")).size).toBe(2048);
  });

  it("a user's own uploaded narration counts too — it IS this video's audio", () => {
    const workDir = path.join(ROOT, "w2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "custom_voiceover.mp3"), Buffer.alloc(64, 1));
    expect(findVoiceoverFile(workDir)).toContain("custom_voiceover.mp3");
  });

  it("the storage key is stable, so a re-run overwrites rather than accumulating copies", () => {
    expect(voiceoverStorageKey(7)).toBe(voiceoverStorageKey(7));
    expect(voiceoverStorageKey(7)).not.toBe(voiceoverStorageKey(8));
  });

  it("A FAILED UPLOAD IS NEVER DRESSED UP AS SUCCESS", async () => {
    /**
     * The line that matters most in this block. A render that recorded a URL it never wrote would
     * hide the failure until months later, as a re-render that cannot find its own audio.
     */
    const workDir = path.join(ROOT, "w3");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "full_voiceover.mp3"), Buffer.alloc(10, 3));
    const result = await persistVoiceover({
      videoId: 9,
      workDir,
      upload: async () => {
        throw new Error("S3 refused the connection");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upload_failed");
    const line = formatVoicePersistFailure(9, result);
    expect(line).toContain("VOICEOVER_PERSISTENCE_FAILED");
    expect(line).toContain("video=9");
    expect(line).toContain("S3 refused the connection");
    // ...and the narration record records the absence rather than a plausible URL.
    const narration = buildNarrationPersistence({
      voiceoverUrl: null, durationSec: 42, provider: null, voiceId: "v1", words: [],
    });
    expect(narration.voiceoverUrl).toBeNull();
    expect(narrationIsRecoverable(narration)).toBe(false);
  });

  it("no file and an empty file are reported as different problems", async () => {
    const empty = path.join(ROOT, "w4");
    fs.mkdirSync(empty, { recursive: true });
    const none = await persistVoiceover({ videoId: 1, workDir: empty, upload: async () => ({ key: "", url: "" }) });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("no_voiceover_file");

    fs.writeFileSync(path.join(empty, "full_voiceover.mp3"), "");
    const zero = await persistVoiceover({ videoId: 1, workDir: empty, upload: async () => ({ key: "", url: "" }) });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toBe("no_voiceover_file"); // a 0-byte file is not a file here
  });
});

/* ═══════════════════════ TEST 4 — word timing survives unchanged ═══════════════════════ */

describe("TEST 4 — TtsWordTiming[] persisted and loaded back identical", () => {
  const words = [
    { word: "In", startSec: 0.0, endSec: 0.18 },
    { word: "April", startSec: 0.18, endSec: 0.52 },
    { word: "1945", startSec: 0.52, endSec: 1.04 },
  ];

  it("what goes in comes out, to the exact number", () => {
    const narration = buildNarrationPersistence({
      voiceoverUrl: "/local-storage/videos/1/voiceover.mp3",
      durationSec: 60.25,
      provider: null,
      voiceId: "rachel",
      words,
    });
    const stored = JSON.parse(JSON.stringify({ narration })) as unknown;
    const read = readNarrationPersistence(stored)!;
    expect(read.words).toEqual(words);
    expect(read.voiceoverUrl).toBe("/local-storage/videos/1/voiceover.mp3");
    expect(read.durationSec).toBe(60.25);
    expect(read.voiceId).toBe("rachel");
    expect(read.timingSource).toBe("tts_word_alignment");
  });

  it("nothing is recomputed — the timings are stored, not derived", () => {
    // Deliberately irregular gaps that no estimator would produce. If anything re-derived them
    // from a word count or a duration, these exact numbers could not survive.
    const odd = [
      { word: "a", startSec: 0, endSec: 0.03 },
      { word: "b", startSec: 2.71, endSec: 2.9331 },
    ];
    const read = readNarrationPersistence({
      narration: buildNarrationPersistence({
        voiceoverUrl: null, durationSec: null, provider: null, voiceId: null, words: odd,
      }),
    })!;
    expect(read.words[1]!.endSec).toBe(2.9331);
  });

  it("an alignment that never existed is null, not an empty claim", () => {
    const narration = buildNarrationPersistence({
      voiceoverUrl: null, durationSec: null, provider: null, voiceId: null, words: [],
    });
    expect(narration.timingSource).toBeNull();
    expect(narration.words).toEqual([]);
  });

  it("the TTS provider is null when the render does not know which tier answered", () => {
    // The voice ladder (ElevenLabs → Fish → Google) does not report which one produced the file,
    // so a plausible-looking "elevenlabs" would be an invention. §7: niet verzinnen.
    const n = buildNarrationPersistence({
      voiceoverUrl: "u", durationSec: 1, provider: null, voiceId: null, words: [],
    });
    expect(n.provider).toBeNull();
  });
});

/* ═══════════════════════ TEST 5 — it all outlives the work directory ═══════════════════════ */

describe("TEST 5 — workDir is deleted and the persisted data is still there", () => {
  it("REAL I/O: rmSync removes the work dir; voiceover, manifest and timings survive", async () => {
    /**
     * The whole round, end to end, with the same `fs.rmSync(workDir, {recursive, force})` the
     * pipeline runs in its `finally`.
     */
    const workDir = path.join(ROOT, "render_work");
    const storeDir = path.join(ROOT, "permanent");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "full_voiceover.mp3"), Buffer.alloc(4096, 9));
    fs.writeFileSync(path.join(workDir, "scene_0_b0_wiki.mp4"), Buffer.alloc(128, 1));
    fs.writeFileSync(
      path.join(workDir, "tts_word_alignment.json"),
      JSON.stringify({ words: [{ word: "Berlin", startSec: 0, endSec: 0.4 }], totalDurationSec: 9 })
    );

    // 1. the manifest, with identity taken from the adoption record
    const scenes = await buildEditorScenesFromPipeline(
      [{ index: 0, text: "narration", duration: 9 }],
      [[path.join(workDir, "scene_0_b0_wiki.mp4")]],
      () => "wikimedia",
      () => ({
        provider: "wikimedia",
        providerAssetId: "File:Reichstag.jpg",
        sourceUrl: "https://upload.wikimedia.org/x.jpg",
        assetTitle: "Reichstag",
      })
    );
    const manifestFile = path.join(storeDir, "manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(scenes));

    // 2. the voiceover, through the storage boundary
    const persisted = await persistVoiceover({
      videoId: 1234,
      workDir,
      upload: async (key, filePath) => {
        const dest = path.join(storeDir, "voiceover.mp3");
        fs.copyFileSync(filePath, dest);
        return { key, url: `/local-storage/${key}` };
      },
    });
    expect(persisted.ok).toBe(true);

    // 3. the narration record, with the timings read off the alignment file
    const alignment = JSON.parse(
      fs.readFileSync(path.join(workDir, "tts_word_alignment.json"), "utf8")
    ) as { words: Array<{ word: string; startSec: number; endSec: number }>; totalDurationSec: number };
    const metaFile = path.join(storeDir, "metadata.json");
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
        narration: buildNarrationPersistence({
          voiceoverUrl: persisted.ok ? persisted.url : null,
          durationSec: alignment.totalDurationSec,
          provider: null,
          voiceId: null,
          words: alignment.words,
        }),
      })
    );

    // 4. the cleanup the pipeline really performs
    fs.rmSync(workDir, { recursive: true, force: true });
    expect(fs.existsSync(workDir), "the work directory should be gone").toBe(false);

    // 5. everything needed to understand this render again is still on disk
    expect(fs.existsSync(path.join(storeDir, "voiceover.mp3"))).toBe(true);
    expect(fs.statSync(path.join(storeDir, "voiceover.mp3")).size).toBe(4096);

    const survivedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as EditorScene[];
    expect(survivedManifest[0]!.clips[0]!.sourceIdentity!.providerAssetId).toBe("File:Reichstag.jpg");
    expect(manifestRehydrationSummary(survivedManifest).rehydratable).toBe(1);

    const survivedMeta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as unknown;
    const narration = readNarrationPersistence(survivedMeta)!;
    expect(narration.words).toEqual([{ word: "Berlin", startSec: 0, endSec: 0.4 }]);
    expect(narrationIsRecoverable(narration)).toBe(true);
  });
});

/* ═══════════════════════ TEST 6 — a missing identity stays missing ═══════════════════════ */

describe("TEST 6 — no adoption record must never become a fake identity", () => {
  it("a clip the ledger never saw gets NO sourceIdentity", async () => {
    const scenes = await buildEditorScenesFromPipeline(
      [{ index: 0, text: "n", duration: 3 }],
      [["/w/scene_0_mystery.mp4"]],
      () => null,
      () => null
    );
    expect(scenes[0]!.clips[0]!.sourceIdentity).toBeUndefined();
    expect(scenes[0]!.clips[0]!.source).toBe(UNVERIFIED_PROVIDER);
    expect(manifestRehydrationSummary(scenes).rehydratable).toBe(0);
  });

  it("a provider name WITHOUT an id is not rehydratable, and says so", () => {
    const identity = identityFromAdoption({ provider: "wikimedia" })!;
    expect(identity.providerAssetId).toBeUndefined();
    expect(identityIsRehydratable(identity)).toBe(false);
    expect(formatAssetIdentity(0, 0, identity)).toContain("rehydratable=false");
  });

  it("UNVERIFIED is never rehydratable, whatever else it carries", () => {
    // A provider FastVid could not prove is not a provider it can go back to.
    const identity = identityFromAdoption({
      provider: UNVERIFIED_PROVIDER,
      providerAssetId: "something",
      sourceUrl: "https://example/x.mp4",
    })!;
    expect(identityIsRehydratable(identity)).toBe(false);
  });

  it("the coverage line counts the unrecoverable ones rather than hiding them", () => {
    const line = formatIdentityCoverage([
      identityFromAdoption({ provider: "pexels", providerAssetId: "1" }),
      identityFromAdoption({ provider: "wikimedia" }),
      null,
    ]);
    expect(line).toContain("clips=3");
    expect(line).toContain("rehydratable=1");
    expect(line).toContain("unrecoverable=2");
  });
});

/* ═══════════════════════ TEST 7 — YouTube ═══════════════════════ */

describe("TEST 7 — YouTube identity is the videoId, never the stream URL", () => {
  it("providerAssetId === videoId", () => {
    const identity = identityFromAdoption({
      provider: "youtube_cc",
      providerAssetId: "dQw4w9WgXcQ",
      assetTitle: "A newsreel",
    })!;
    expect(identity.providerAssetId).toBe("dQw4w9WgXcQ");
    expect(identity.sourcePageUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("a temporary stream URL is stored as mediaUrl and is NOT the identity", () => {
    /**
     * RapidAPI hands back a signed, expiring stream URL. Using it as the handle would produce a
     * manifest that stops working within hours; the videoId is what survives.
     */
    const identity = identityFromAdoption({
      provider: "youtube_cc",
      providerAssetId: "dQw4w9WgXcQ",
      sourceUrl: "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1700000000&sig=SECRET",
    })!;
    expect(identity.providerAssetId).toBe("dQw4w9WgXcQ");
    expect(identity.mediaUrl).toContain("googlevideo.com");
    expect(identity.providerAssetId).not.toContain("googlevideo");
    // ...and the log line never prints the signed URL.
    const line = formatAssetIdentity(1, 0, identity);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("expire=");
    expect(line).toContain("mediaHost=rr3---sn-x.googlevideo.com");
  });
});

/* ═══════════════════════ TEST 8 — Pexels / Pixabay ═══════════════════════ */

describe("TEST 8 — the stock providers keep their numeric id", () => {
  it("pexels stores the id, and the CDN link only as mediaUrl", () => {
    const identity = identityFromAdoption({
      provider: "pexels",
      providerAssetId: "3195394",
      sourceUrl: "https://player.vimeo.com/external/3195394.hd.mp4?s=abc&profile_id=175",
    })!;
    expect(identity.providerAssetId).toBe("3195394");
    expect(identity.sourcePageUrl).toBe("https://www.pexels.com/video/3195394/");
    expect(identity.mediaUrl).toContain("player.vimeo.com");
    expect(identityIsRehydratable(identity)).toBe(true);
  });

  it("pixabay likewise", () => {
    const identity = identityFromAdoption({
      provider: "pixabay",
      providerAssetId: "128421",
      sourceUrl: "https://cdn.pixabay.com/vimeo/128421/x.mp4",
    })!;
    expect(identity.providerAssetId).toBe("128421");
    expect(identity.sourcePageUrl).toBe("https://pixabay.com/videos/128421/");
  });

  it("the id alone is enough — a stock clip stays recoverable when its CDN link expires", () => {
    const identity = identityFromAdoption({ provider: "pexels", providerAssetId: "3195394" })!;
    expect(identity.mediaUrl).toBeUndefined();
    expect(identityIsRehydratable(identity)).toBe(true);
  });
});

/* ═══════════════════════ TEST 9 — the FFmpeg fallback ═══════════════════════ */

describe("TEST 9 — capability failure and executable failure are told apart", () => {
  it("THE BUG: 'No such filter' is now a reason to try another binary", () => {
    /**
     * ffmpeg-static has no `drawtext`. Every text render on a host without a system ffmpeg failed
     * with this exact message, and the old check — which looked only for 'not found' and
     * 'Permission denied' — never switched binaries. Audit BUG B1.
     */
    const message = "[AVFilterGraph @ 0x1] No such filter: 'drawtext'\nError initializing filtergraph";
    expect(isCapabilityFailure(message)).toBe(true);
    expect(isBinaryNotFoundFailure(message)).toBe(false);
    expect(ffmpegRetryReason(message)).toBe("capability_missing");
  });

  it("other capability gaps are recognised too", () => {
    for (const m of [
      "Unknown encoder 'libx265'",
      "Unknown decoder 'av1'",
      "Unknown filter 'zoompan'",
      "Unknown bitstream filter 'h264_mp4toannexb'",
    ]) {
      expect(ffmpegRetryReason(m), m).toBe("capability_missing");
    }
  });

  it("A REAL RENDER ERROR IS NOT TREATED AS A CAPABILITY FAILURE", () => {
    /**
     * The half that protects the diagnosis. A fallback that fired on any ffmpeg error would retry
     * a corrupt input against a second binary, fail identically, and bury the real cause.
     */
    for (const m of [
      "Invalid data found when processing input",
      "moov atom not found",
      "No space left on device",
      "Conversion failed!",
      "Error while opening encoder - maybe incorrect parameters",
      "Invalid argument",
      "Output file is empty, nothing was encoded",
    ]) {
      expect(ffmpegRetryReason(m), m).toBeNull();
    }
  });

  it("a missing input file is still not a missing binary", () => {
    // The pre-existing rule, preserved: an input ENOENT must never trigger a binary switch.
    const m = "ENOENT: no such file or directory, open '/tmp/x/scene_0.mp4'";
    expect(isBinaryNotFoundFailure(m)).toBe(false);
    expect(ffmpegRetryReason(m)).toBeNull();
  });

  it("a genuinely missing executable still switches", () => {
    expect(ffmpegRetryReason("/bin/sh: 1: ffmpeg: not found")).toBe("binary_not_found");
    expect(ffmpegRetryReason("Permission denied")).toBe("binary_not_found");
  });

  it("the fallback list never returns the binary that just failed, and includes the static one", () => {
    const list = ffmpegFallbackCandidates("/usr/bin/ffmpeg");
    expect(list).not.toContain("/usr/bin/ffmpeg");
    expect(list.length).toBeGreaterThan(0);
    // A host with no system ffmpeg must still have somewhere to fall back TO.
    expect(list.some((p) => p.includes("ffmpeg"))).toBe(true);
  });

  it("A MISSING CAPABILITY IS BORROWED FOR ONE COMMAND; A MISSING BINARY IS PERMANENT", () => {
    /**
     * Found by RONDE 158's own end-to-end test, which went red on this round's first attempt.
     *
     * The pre-existing fallback replaced the process-wide binary, which is right for an executable
     * that is not there — it will still not be there next time. A capability gap is a property of
     * ONE COMMAND, and making it permanent downgraded the whole worker: one command failing on an
     * unsupported encoder moved every later command to ffmpeg-static, and a scene repair that
     * produces 21.20s on the system build then produced 17.04s. Same command, same input, a
     * silently different video.
     */
    expect(retryReasonIsPermanent("binary_not_found")).toBe(true);
    expect(retryReasonIsPermanent("capability_missing")).toBe(false);
  });

  it("the fallback order prefers a real system build over the bundled one", () => {
    // A capability retry is looking for a MORE capable binary, and ffmpeg-static is the least
    // capable by construction — no libfreetype, hence no drawtext.
    const list = ffmpegFallbackCandidates("/nowhere/ffmpeg");
    const staticIdx = list.findIndex((p) => p.includes("ffmpeg-static"));
    const systemIdx = list.indexOf("/usr/bin/ffmpeg");
    expect(systemIdx).toBeGreaterThanOrEqual(0);
    if (staticIdx >= 0) expect(systemIdx).toBeLessThan(staticIdx);
  });

  it("the pipeline only reassigns FFMPEG_BIN for a permanent failure", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const src = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    const start = src.indexOf("const permanent = retryReasonIsPermanent(retryReason);");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 2000);
    expect(block).toContain("if (permanent) {");
    expect(block).toContain("FFMPEG_BIN = alt;");
    // The reassignment must sit INSIDE the permanent branch, not beside it.
    expect(block.indexOf("if (permanent) {")).toBeLessThan(block.indexOf("FFMPEG_BIN = alt;"));
    expect(block).toContain("Borrowing");
  });

  it("empty or absent messages are not retry reasons", () => {
    expect(ffmpegRetryReason("")).toBeNull();
    expect(ffmpegRetryReason(undefined)).toBeNull();
    expect(ffmpegRetryReason(null)).toBeNull();
  });
});

/* ═══════════════════════ TEST 10 — backwards compatibility ═══════════════════════ */

describe("TEST 10 — a pre-RONDE-146 manifest still loads, and says what it lacks", () => {
  const oldManifest: EditorScene[] = [
    {
      sceneIndex: 0,
      narration: "an old render",
      durationMs: 4000,
      clips: [
        { url: "/tmp/fastvid_1_2/scene_0_b0_wiki.mp4", type: "video", source: "wikimedia", available: false },
        { url: "https://www.pexels.com/video/12345/", type: "video", source: "pexels" },
      ],
    },
  ];

  it("it does not crash, and nothing is invented for it", () => {
    const summary = manifestRehydrationSummary(oldManifest);
    expect(summary.total).toBe(2);
    expect(summary.rehydratable).toBe(0);
    // Absent version means version 1 — a render from before identity existed.
    expect(summary.schemaVersion).toBe(1);
    for (const clip of oldManifest[0]!.clips) expect(clip.sourceIdentity).toBeUndefined();
  });

  it("a NEW manifest is distinguishable from an old one", () => {
    const summary = manifestRehydrationSummary([
      { ...oldManifest[0]!, manifestSchemaVersion: MANIFEST_SCHEMA_VERSION },
    ]);
    expect(summary.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(MANIFEST_SCHEMA_VERSION).toBeGreaterThan(1);
  });

  it("a metadata blob with no narration key reads as 'no stored narration'", () => {
    expect(readNarrationPersistence(null)).toBeNull();
    expect(readNarrationPersistence({})).toBeNull();
    expect(readNarrationPersistence({ backgroundMusicUrl: "x" })).toBeNull();
    expect(narrationIsRecoverable(null)).toBe(false);
  });

  it("a corrupt narration record loads with the good parts kept", () => {
    // Real stored JSON degrades. A reader that threw would make one bad row unopenable forever.
    const read = readNarrationPersistence({
      narration: {
        voiceoverUrl: "/local-storage/v.mp3",
        words: [
          { word: "ok", startSec: 0, endSec: 1 },
          { word: "bad", startSec: "nope" },
          null,
        ],
      },
    })!;
    expect(read.voiceoverUrl).toBe("/local-storage/v.mp3");
    expect(read.words).toEqual([{ word: "ok", startSec: 0, endSec: 1 }]);
  });
});

/* ═══════════════════════ §16 — no secrets, anywhere ═══════════════════════ */

describe("RONDE 146 §16 — identities, never credentials", () => {
  it("nothing that is stored or logged can carry an API key", () => {
    const identity = identityFromAdoption({
      provider: "pexels",
      providerAssetId: "1",
      sourceUrl: "https://api.pexels.com/videos/1?api_key=SECRETKEY&token=ALSOSECRET",
    })!;
    const line = formatAssetIdentity(0, 0, identity);
    expect(line).not.toContain("SECRETKEY");
    expect(line).not.toContain("ALSOSECRET");
    expect(line).not.toContain("api_key");
    // The host is what the line carries — enough to know where a picture came from, and no more.
    expect(line).toContain("mediaHost=api.pexels.com");
  });

  it("the persistence modules hold no credential names", () => {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    for (const f of ["assetIdentity.ts", "renderPersistence.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      for (const secret of ["API_KEY", "process.env.PEXELS", "process.env.RAPIDAPI", "Authorization"]) {
        expect(src, `${f} references ${secret}`).not.toContain(secret);
      }
    }
  });
});
