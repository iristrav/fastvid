#!/usr/bin/env python3
"""
Insert fetchPixabayClips() function into videoPipeline.ts and integrate it into:
1. fetchBrollClips() — adds Pixabay as a parallel B-roll source
2. fetchSceneVisuals() Promise.allSettled — adds Pixabay as a main clip source
"""

with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'r') as f:
    content = f.read()

# ─── 1. Insert fetchPixabayClips function after fetchBrollClips ───────────────
PIXABAY_FUNCTION = '''
// ─── 3b3. Fetch Clips from Pixabay (B-roll + main visual source) ─────────────────────────────
// Pixabay Video API: free, no attribution required for commercial use.
// Returns up to `count` trimmed HD clips matching the query.
async function fetchPixabayClips(
  query: string,
  clipDuration: number,
  workDir: string,
  sceneIndex: number,
  count: number = 2,
  suffix: string = "pixabay"
): Promise<string[]> {
  if (!PIXABAY_API_KEY) return [];
  const results: string[] = [];

  // Build query list: primary query + cinematic fallbacks
  const queryList = [query, 'cinematic nature landscape', 'aerial city drone'];
  const seen = new Set<string>();
  const uniqueQueries = queryList.filter(q => { if (seen.has(q)) return false; seen.add(q); return true; });

  for (const currentQuery of uniqueQueries) {
    if (results.length >= count) break;
    try {
      // Pixabay Video API: https://pixabay.com/api/docs/#api_videos
      // video_type=film gives real footage (not animation); min_width=1280 for HD
      const searchUrl =
        `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}` +
        `&q=${encodeURIComponent(currentQuery)}` +
        `&per_page=10&video_type=film&min_width=1280&safesearch=true`;

      const searchResp = await withTimeout(
        fetch(searchUrl),
        10_000,
        `Pixabay search scene ${sceneIndex} query "${currentQuery}"`
      );
      if (!searchResp.ok) {
        console.warn(`[Pipeline] Pixabay search HTTP ${searchResp.status} for "${currentQuery}"`);
        continue;
      }

      const searchData = await searchResp.json() as {
        totalHits?: number;
        hits?: Array<{
          id: number;
          duration: number;
          videos: {
            large?: { url: string; width: number; height: number; size: number };
            medium?: { url: string; width: number; height: number; size: number };
            small?: { url: string; width: number; height: number; size: number };
          };
        }>;
      };

      if (!searchData.hits?.length) continue;

      // Filter: min 3s duration, sort by resolution descending
      const candidates = searchData.hits
        .filter(v => v.duration >= 3)
        .sort((a, b) => {
          const aW = a.videos.large?.width ?? a.videos.medium?.width ?? 0;
          const bW = b.videos.large?.width ?? b.videos.medium?.width ?? 0;
          return bW - aW;
        })
        .slice(0, count * 2);

      for (let idx = 0; idx < candidates.length && results.length < count; idx++) {
        const video = candidates[idx];
        // Prefer large (1080p) → medium (720p) → small
        const videoFile =
          video.videos.large?.url ? video.videos.large :
          video.videos.medium?.url ? video.videos.medium :
          video.videos.small?.url ? video.videos.small : null;

        if (!videoFile?.url) continue;

        const rawPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_${idx}_raw.mp4`);
        const outPath = path.join(workDir, `scene_${sceneIndex}_${suffix}_${idx}.mp4`);

        try {
          // Download with retry
          let buffer: Buffer | null = null;
          for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
            try {
              const dlResp = await withTimeout(
                fetch(videoFile.url),
                20_000,
                `Pixabay download scene ${sceneIndex} clip ${idx} attempt ${attempt + 1}`
              );
              if (!dlResp.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
              const buf = Buffer.from(await dlResp.arrayBuffer());
              if (buf.length < 50_000) { await new Promise(r => setTimeout(r, 1000)); continue; }
              buffer = buf;
            } catch (dlErr) {
              console.warn(`[Pipeline] Pixabay download attempt ${attempt + 1} failed:`, dlErr);
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          if (!buffer) continue;

          fs.writeFileSync(rawPath, buffer);

          // Validate with ffprobe
          const FFPROBE_BIN = '/usr/bin/ffprobe';
          try {
            const probeResult = await withTimeout(
              exec(`${FFPROBE_BIN} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawPath}" 2>&1`),
              10_000, `Probe Pixabay clip ${idx}`
            );
            const dur = parseFloat(typeof probeResult === 'string' ? probeResult : (probeResult as any).stdout || '');
            if (isNaN(dur) || dur < 1) { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }
          } catch { try { fs.unlinkSync(rawPath); } catch { /**/ } continue; }

          // Ken Burns + trim
          const loopFlag = video.duration < clipDuration ? '-stream_loop -1' : '';
          const panX = (sceneIndex + idx) % 3 === 0
            ? `(iw-${VIDEO_WIDTH})/2*t/${clipDuration}`
            : (sceneIndex + idx) % 3 === 1
              ? `(iw-${VIDEO_WIDTH})/2*(1-t/${clipDuration})`
              : `(iw-${VIDEO_WIDTH})/2`;

          await withTimeout(
            exec(
              `${FFMPEG_BIN} -y ${loopFlag} -i "${rawPath}" ` +
              `-t ${clipDuration} ` +
              `-vf "scale=${Math.round(VIDEO_WIDTH * 1.08)}:${Math.round(VIDEO_HEIGHT * 1.08)}:force_original_aspect_ratio=increase,` +
              `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${panX}:(ih-${VIDEO_HEIGHT})/2" ` +
              `-c:v libx264 -preset veryfast -crf 18 -an -pix_fmt yuv420p "${outPath}"`
            ),
            45_000,
            `Trim Pixabay clip ${idx} scene ${sceneIndex}`
          );

          try { fs.unlinkSync(rawPath); } catch { /**/ }

          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1_000) {
            results.push(outPath);
            console.log(`[Pipeline] Scene ${sceneIndex}: Pixabay clip added: "${currentQuery}"`);
          }
        } catch (err) {
          console.warn(`[Pipeline] Pixabay clip ${idx} failed for scene ${sceneIndex}:`, (err as Error).message);
          try { fs.unlinkSync(rawPath); } catch { /**/ }
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Pixabay search failed for query "${currentQuery}" scene ${sceneIndex}:`, err);
    }
  }

  return results;
}

'''

BROLL_MARKER = '// ─── 3c2. Wikimedia Commons Image Search ────────────────────────────────────'
if BROLL_MARKER in content:
    content = content.replace(BROLL_MARKER, PIXABAY_FUNCTION + BROLL_MARKER)
    print("SUCCESS: fetchPixabayClips function inserted")
else:
    print("ERROR: Wikimedia marker not found — cannot insert fetchPixabayClips")
    exit(1)

# ─── 2. Update fetchBrollClips to also call Pixabay in parallel ──────────────
OLD_BROLL_GUARD = 'if (!PEXELS_API_KEY || !brollQueries || brollQueries.length === 0) return [];'
NEW_BROLL_GUARD = 'if ((!PEXELS_API_KEY && !PIXABAY_API_KEY) || !brollQueries || brollQueries.length === 0) return [];'
if OLD_BROLL_GUARD in content:
    content = content.replace(OLD_BROLL_GUARD, NEW_BROLL_GUARD, 1)
    print("SUCCESS: fetchBrollClips guard updated to allow Pixabay-only mode")
else:
    print("WARNING: fetchBrollClips guard not found — skipping")

# ─── 3. Add Pixabay to the Promise.allSettled call in fetchSceneVisuals ──────
OLD_ALLSETTLED = (
    '    fetchPexelsClips(scene.pexelsQuery, halfDur, workDir, scene.index, 3, scene.pexelsQueries),\n'
    '    fetchBrollClips(scene.brollQueries || [], halfDur, workDir, scene.index),'
)
NEW_ALLSETTLED = (
    '    fetchPexelsClips(scene.pexelsQuery, halfDur, workDir, scene.index, 3, scene.pexelsQueries),\n'
    '    fetchPixabayClips(scene.pexelsQuery, halfDur, workDir, scene.index, 2),\n'
    '    fetchBrollClips(scene.brollQueries || [], halfDur, workDir, scene.index),'
)
if OLD_ALLSETTLED in content:
    content = content.replace(OLD_ALLSETTLED, NEW_ALLSETTLED, 1)
    print("SUCCESS: Pixabay added to Promise.allSettled in fetchSceneVisuals")
else:
    print("ERROR: Promise.allSettled pattern not found — cannot add Pixabay to main fetch")
    exit(1)

# ─── 4. Update the destructuring assignment to include pixabayResults ─────────
OLD_DESTRUCTURE = (
    'const [aiResult, leonardoResult, runwayResult, klingResult, lumaResult, pikaResult, forgeResult, '
    'grokResult, veoResult, metaResult, higgsfieldTextResult, higgsfieldImageResult, pexelsResults, '
    'brollResults, wikimediaResults, wikimedia2Results, serpResults, serp2Results, archiveResults, youtubeResults] = await Promise.allSettled(['
)
NEW_DESTRUCTURE = (
    'const [aiResult, leonardoResult, runwayResult, klingResult, lumaResult, pikaResult, forgeResult, '
    'grokResult, veoResult, metaResult, higgsfieldTextResult, higgsfieldImageResult, pexelsResults, '
    'pixabayResults, brollResults, wikimediaResults, wikimedia2Results, serpResults, serp2Results, archiveResults, youtubeResults] = await Promise.allSettled(['
)
if OLD_DESTRUCTURE in content:
    content = content.replace(OLD_DESTRUCTURE, NEW_DESTRUCTURE, 1)
    print("SUCCESS: Destructuring updated to include pixabayResults")
else:
    print("ERROR: Destructuring pattern not found")
    exit(1)

# ─── 5. Add Pixabay clip assembly after Pexels clips ─────────────────────────
OLD_BROLL_ASSEMBLY = (
    '  // Then B-roll clips (already color-graded in fetchBrollClips) — insert after main Pexels clips for visual variety\n'
    '  const brollClips = brollResults.status === "fulfilled" ? brollResults.value : [];'
)
NEW_BROLL_ASSEMBLY = (
    '  // Then Pixabay clips — apply fair-use transformation (color grade + vignette)\n'
    '  const pixabayClips = pixabayResults.status === "fulfilled" ? pixabayResults.value : [];\n'
    '  for (let i = 0; i < pixabayClips.length; i++) {\n'
    '    const transformed = await transformClipForFairUse(pixabayClips[i], scene.text, scene.index, pexelsClips.length + i, workDir);\n'
    '    clips.push(transformed);\n'
    '  }\n'
    '\n'
    '  // Then B-roll clips (already color-graded in fetchBrollClips) — insert after main clips for visual variety\n'
    '  const brollClips = brollResults.status === "fulfilled" ? brollResults.value : [];'
)
if OLD_BROLL_ASSEMBLY in content:
    content = content.replace(OLD_BROLL_ASSEMBLY, NEW_BROLL_ASSEMBLY, 1)
    print("SUCCESS: Pixabay clip assembly added after Pexels clips")
else:
    print("ERROR: B-roll assembly pattern not found")
    exit(1)

# ─── 6. Update the final log line to include Pixabay count ───────────────────
OLD_LOG = (
    'console.log(`[Pipeline] Scene ${scene.index}${personLabel}: ${clips.length} clip(s) ready '
    '(Stability: ${aiClip ? "✓" : "✗"}, Grok: ${grokClip ? "✓" : "✗"}, Veo: ${veoClip ? "✓" : "✗"}, '
    'Meta: ${metaClip ? "✓" : "✗"}, Higgsfield: ${higgsfieldTextClip || higgsfieldImageClip ? "✓" : "✗"}, '
    'Pexels: ${pexelsClips.length}, B-roll: ${brollClips.length}, Wikimedia: ${wikimediaClips.length + wikimedia2Clips.length}, '
    'SerpAPI: ${serpClips.length + serp2Clips.length}, Archive: ${archiveClips.length}, YouTube CC: ${youtubeClips.length})`);'
)
NEW_LOG = (
    'console.log(`[Pipeline] Scene ${scene.index}${personLabel}: ${clips.length} clip(s) ready '
    '(Stability: ${aiClip ? "✓" : "✗"}, Grok: ${grokClip ? "✓" : "✗"}, Veo: ${veoClip ? "✓" : "✗"}, '
    'Meta: ${metaClip ? "✓" : "✗"}, Higgsfield: ${higgsfieldTextClip || higgsfieldImageClip ? "✓" : "✗"}, '
    'Pexels: ${pexelsClips.length}, Pixabay: ${pixabayClips.length}, B-roll: ${brollClips.length}, '
    'Wikimedia: ${wikimediaClips.length + wikimedia2Clips.length}, '
    'SerpAPI: ${serpClips.length + serp2Clips.length}, Archive: ${archiveClips.length}, YouTube CC: ${youtubeClips.length})`);'
)
if OLD_LOG in content:
    content = content.replace(OLD_LOG, NEW_LOG, 1)
    print("SUCCESS: Log line updated to include Pixabay count")
else:
    print("WARNING: Log line pattern not found — skipping log update")

# ─── 7. Update the priority comment ──────────────────────────────────────────
OLD_COMMENT = (
    '  // Run all AI video generators, Pexels fetch, Wikimedia, SerpAPI, Internet Archive, YouTube CC, and B-roll in parallel\n'
    '  // Priority: Stability AI → Leonardo → Runway → Kling → Luma → Pika → Manus Forge → Grok → Veo → Meta → Higgsfield → Pexels → B-roll → Wikimedia → SerpAPI → Internet Archive → YouTube CC → Color fallback'
)
NEW_COMMENT = (
    '  // Run all AI video generators, Pexels fetch, Pixabay fetch, Wikimedia, SerpAPI, Internet Archive, YouTube CC, and B-roll in parallel\n'
    '  // Priority: Stability AI → Leonardo → Runway → Kling → Luma → Pika → Manus Forge → Grok → Veo → Meta → Higgsfield → Pexels → Pixabay → B-roll → Wikimedia → SerpAPI → Internet Archive → YouTube CC → Color fallback'
)
if OLD_COMMENT in content:
    content = content.replace(OLD_COMMENT, NEW_COMMENT, 1)
    print("SUCCESS: Priority comment updated")
else:
    print("WARNING: Priority comment not found — skipping")

with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'w') as f:
    f.write(content)

print("\nAll changes applied successfully!")
