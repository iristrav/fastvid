#!/usr/bin/env python3
"""
Quality upgrade script: make Fastvid pipeline surpass the reference video.
Changes:
1. Replace xfade transitions with HARD CUTS (reference uses zero crossfades)
2. Reduce clip duration: 2-4s per clip (reference: 1-4s)
3. Chapter card: yellow background (#FFD700), black text
4. Add statCallout field to Scene + LLM prompt + JSON schema
5. Dynamic music ducking: VO=100%, music=8% under VO, 22% during pauses
6. Add literalVisualCue to LLM prompt for hyper-specific B-roll matching
7. Remove zoom-punch zoompan (reference uses static Ken Burns, not animated zoom)
"""

with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'r') as f:
    content = f.read()

changes = []

# ─── 1. Replace xfade transitions with HARD CUTS ─────────────────────────────
# Remove the xfade chain and replace with simple concat-style scale+trim per clip
OLD_XFADE_COMMENT = '''  // Vidrush-style transitions: alternate between slideleft and fade for visual variety
  // slideleft: clips slide in from right (dynamic, modern feel)
  // fade: classic dissolve (used for every other transition to avoid monotony)
  const xfadeDur = 0.25; // slightly longer for visible transition effect
  const xfadeTransitions = ['slideleft', 'fade', 'slideleft', 'fade', 'slideleft', 'fade'];'''
NEW_XFADE_COMMENT = '''  // Reference video style: HARD CUTS only between clips (no xfade/crossfade/slide)
  // Hard cuts are faster, more energetic, and match the reference video exactly.
  // Each clip is trimmed to clipDur seconds, then concatenated with a hard cut.'''

if OLD_XFADE_COMMENT in content:
    content = content.replace(OLD_XFADE_COMMENT, NEW_XFADE_COMMENT, 1)
    changes.append("1a. Removed xfade transition variables")
else:
    print("WARNING: xfade comment not found")

# Replace the multi-clip xfade chain with hard-cut concat using filter_complex concat
OLD_MULTI_CLIP = '''      // Chain xfades — alternate between slideleft and fade for Vidrush-style visual variety
      let xfadeChain = "";
      let lastLabel = "v0";
      for (let i = 1; i < safeClips.length; i++) {
        const offset = Math.max(0.5, clipDur * i - xfadeDur);
        const outLabel = i === safeClips.length - 1 ? "xfaded" : `xf${i}`;
        const transition = xfadeTransitions[(i - 1) % xfadeTransitions.length];
        xfadeChain += `;[${lastLabel}][v${i}]xfade=transition=${transition}:duration=${xfadeDur}:offset=${offset}[${outLabel}]`;
        lastLabel = outLabel;
      }

      // Build kinetic chain on top of xfaded
      // Input indices: 0..N-1 = clips, N = audio, N+1.. = kinetic frames
      const audioIdx = safeClips.length;
      const kineticBaseIdx = audioIdx + 1;
      const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
        buildKineticChain("xfaded", kineticBaseIdx);

      const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
      const kineticChainStr = kChain ? kChain : "";
      const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "xfaded";
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}"${kineticInput} ` +
          `-filter_complex "${scaleFilters}${xfadeChain}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
          `-map "[vout]" -map "${audioIdx}:a" ` +
          `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        120_000, `Compose multi-clip scene ${scene.index}`
      );'''

NEW_MULTI_CLIP = '''      // Hard-cut concat: use filter_complex concat to join clips with zero-duration cuts
      // This matches the reference video exactly — no crossfades, no slides, pure hard cuts
      const concatInputLabels = safeClips.map((_, i) => `[v${i}]`).join("");
      const hardCutConcat = `;${concatInputLabels}concat=n=${safeClips.length}:v=1:a=0[concatenated]`;

      // Build kinetic chain on top of concatenated
      // Input indices: 0..N-1 = clips, N = audio, N+1.. = kinetic frames
      const audioIdx = safeClips.length;
      const kineticBaseIdx = audioIdx + 1;
      const { extraInputs: kExtraInputs, filterChain: kChain, finalLabel: kFinalLabel } =
        buildKineticChain("concatenated", kineticBaseIdx);

      const kineticInput = kExtraInputs ? ` ${kExtraInputs}` : "";
      const kineticChainStr = kChain ? kChain : "";
      const finalVideoLabel = kineticFrames.length > 0 ? kFinalLabel : "concatenated";
      await withTimeout(
        exec(
          `${FFMPEG_BIN} -y ${inputs} -i "${safeAudioPath}"${kineticInput} ` +
          `-filter_complex "${scaleFilters}${hardCutConcat}${kineticChainStr};[${finalVideoLabel}]${fadeFilter}[vout]" ` +
          `-map "[vout]" -map "${audioIdx}:a" ` +
          `-t ${duration} ${threadFlag} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 320k -pix_fmt yuv420p "${outputPath}"`
        ),
        120_000, `Compose multi-clip scene ${scene.index}`
      );'''

if OLD_MULTI_CLIP in content:
    content = content.replace(OLD_MULTI_CLIP, NEW_MULTI_CLIP, 1)
    changes.append("1b. Replaced xfade chain with hard-cut concat filter")
else:
    print("ERROR: multi-clip xfade chain not found")

# ─── 2. Reduce clip duration: target 2-3s per clip (reference: 1-4s) ─────────
# The clipDur calculation: Math.max(2, Math.floor(duration / safeClips.length))
# Change to Math.min(3, Math.max(2, Math.floor(duration / safeClips.length)))
OLD_CLIP_DUR = '      const clipDur = Math.max(2, Math.floor(duration / safeClips.length));'
NEW_CLIP_DUR = '      const clipDur = Math.min(3, Math.max(2, Math.floor(duration / safeClips.length))); // Reference: 1-4s clips'
if OLD_CLIP_DUR in content:
    content = content.replace(OLD_CLIP_DUR, NEW_CLIP_DUR, 1)
    changes.append("2. Clip duration capped at 3s (reference: 1-4s)")
else:
    print("WARNING: clipDur line not found")

# ─── 3. Remove zoom-punch zoompan from multi-clip first clip ─────────────────
# Replace the complex zoompan filter with a simple scale+crop+fps (Ken Burns static)
OLD_SCALE_FILTERS = '''      const scaleFilters = safeClips.map((_, i) => {
        if (i === 0) {
          // First clip: zoom punch from 1.0 to 1.05 over first 0.3s, then hold at 1.05
          return `[${i}:v]scale=${Math.round(VIDEO_WIDTH * 1.10)}:${Math.round(VIDEO_HEIGHT * 1.10)}:force_original_aspect_ratio=increase,` +
            `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25,` +
            `zoompan=z='if(lte(on,${ZOOM_PUNCH_FRAMES}),1.0+on*${ZOOM_PUNCH_STEP.toFixed(6)},1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${ZOOM_PUNCH_FRAMES * 4}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${ZOOM_PUNCH_FPS}[v${i}]`;
        }
        return `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25[v${i}]`;
      }).join(";");'''
NEW_SCALE_FILTERS = '''      // Ken Burns: simple scale+crop+fps, no animated zoom punch (reference uses static Ken Burns)
      const scaleFilters = safeClips.map((_, i) => {
        return `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25[v${i}]`;
      }).join(";");'''
if OLD_SCALE_FILTERS in content:
    content = content.replace(OLD_SCALE_FILTERS, NEW_SCALE_FILTERS, 1)
    changes.append("3a. Removed zoom-punch from multi-clip scale filters")
else:
    print("WARNING: multi-clip scale filters not found")

# Also remove the ZOOM_PUNCH constants that are now unused
OLD_ZOOM_CONSTS = '''      // Add fps=25 to normalize timebase before xfade (prevents 'timebase mismatch' error)
      // Vidrush-style zoom punch: first clip gets a subtle scale 1.0→1.05 zoom over 0.3s for energy
      const ZOOM_PUNCH_FPS = 25;
      const ZOOM_PUNCH_DUR = 0.3; // seconds
      const ZOOM_PUNCH_FRAMES = Math.ceil(ZOOM_PUNCH_DUR * ZOOM_PUNCH_FPS);
      const ZOOM_PUNCH_STEP = (1.05 - 1.0) / ZOOM_PUNCH_FRAMES;'''
NEW_ZOOM_CONSTS = '      // fps=25 normalizes timebase for concat filter'
if OLD_ZOOM_CONSTS in content:
    content = content.replace(OLD_ZOOM_CONSTS, NEW_ZOOM_CONSTS, 1)
    changes.append("3b. Removed unused ZOOM_PUNCH constants")
else:
    print("WARNING: ZOOM_PUNCH constants not found")

# Remove zoom-punch from single-clip path too
OLD_SINGLE_ZOOM = '''      // Single clip: zoom punch from 1.0 to 1.05 over first 0.3s (Vidrush energy effect)
      const SP_FPS = 25;
      const SP_FRAMES = Math.ceil(0.3 * SP_FPS);
      const SP_STEP = (1.05 - 1.0) / SP_FRAMES;
      const singleZoomFilter = `scale=${Math.round(VIDEO_WIDTH * 1.10)}:${Math.round(VIDEO_HEIGHT * 1.10)}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25,` +
        `zoompan=z='if(lte(on,${SP_FRAMES}),1.0+on*${SP_STEP.toFixed(6)},1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${SP_FRAMES * 4}:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:fps=${SP_FPS}`;'''
NEW_SINGLE_ZOOM = '''      // Single clip: simple scale+crop (reference uses static Ken Burns, no animated zoom)
      const singleZoomFilter = `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=25`;'''
if OLD_SINGLE_ZOOM in content:
    content = content.replace(OLD_SINGLE_ZOOM, NEW_SINGLE_ZOOM, 1)
    changes.append("3c. Removed zoom-punch from single-clip path")
else:
    print("WARNING: single-clip zoom filter not found")

# ─── 4. Chapter card: yellow background, black text ──────────────────────────
OLD_CHAPTER_BG = '        // Deep black background\n        ctx.fillStyle = "#080808";\n        ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);\n\n        // Subtle vignette\n        const vignette = ctx.createRadialGradient(centerX, centerY, VIDEO_HEIGHT * 0.2, centerX, centerY, VIDEO_HEIGHT * 0.8);\n        vignette.addColorStop(0, "rgba(0,0,0,0)");\n        vignette.addColorStop(1, "rgba(0,0,0,0.6)");\n        ctx.fillStyle = vignette;\n        ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);\n\n        // Accent lines\n        ctx.globalAlpha = lineAlpha;\n        ctx.fillStyle = "white";\n        ctx.fillRect(lineX1, lineY1, lineX2 - lineX1, 2);\n        ctx.fillRect(lineX1, lineY2, lineX2 - lineX1, 2);\n        ctx.globalAlpha = 1;\n\n        // Chapter title text\n        ctx.globalAlpha = textAlpha;\n        ctx.font = FONT_BOLD ? `bold 72px NotoSans` : `bold 72px sans-serif`;\n        ctx.fillStyle = "white";\n        ctx.textAlign = "center";\n        ctx.textBaseline = "alphabetic";\n        ctx.shadowColor = "rgba(0,0,0,0.8)";\n        ctx.shadowBlur = 12;\n        ctx.shadowOffsetX = 3;\n        ctx.shadowOffsetY = 3;\n        ctx.fillText(title, centerX, titleY);'
NEW_CHAPTER_BG = '''        // SOLID YELLOW background (reference video style: black text on yellow)
        ctx.fillStyle = "#FFD700";
        ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

        // Chapter title text: black on yellow (high contrast, reference style)
        ctx.globalAlpha = textAlpha;
        ctx.font = FONT_BOLD ? `bold 80px NotoSans` : `bold 80px sans-serif`;
        ctx.fillStyle = "#111111";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.shadowColor = "rgba(0,0,0,0)"; // no shadow needed on yellow bg
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillText(title, centerX, titleY);'''
if OLD_CHAPTER_BG in content:
    content = content.replace(OLD_CHAPTER_BG, NEW_CHAPTER_BG, 1)
    changes.append("4. Chapter card: yellow background (#FFD700), black text")
else:
    print("WARNING: chapter card background not found")

# ─── 5. Add statCallout to Scene interface ────────────────────────────────────
OLD_SCENE_INTERFACE = '''  // Vidrush-quality fields
  highlightWords?: string[]; // 2-3 power words for kinetic typography overlay (LLM-generated)
  brollQueries?: string[];   // 2 specific B-roll search queries for cutaway footage'''
NEW_SCENE_INTERFACE = '''  // Vidrush-quality fields
  highlightWords?: string[]; // 2-3 power words for kinetic typography overlay (LLM-generated)
  brollQueries?: string[];   // 2 specific B-roll search queries for cutaway footage
  statCallout?: string;      // 1 key statistic/number for yellow corner callout box (e.g. "45°C", "2%", "$4B")'''
if OLD_SCENE_INTERFACE in content:
    content = content.replace(OLD_SCENE_INTERFACE, NEW_SCENE_INTERFACE, 1)
    changes.append("5a. Added statCallout to Scene interface")
else:
    print("WARNING: Scene interface fields not found")

# Add statCallout to LLM system prompt
OLD_BROLL_PROMPT = '''- brollQueries: Array of exactly 2 specific B-roll search queries for cutaway footage that would visually complement this scene. These should be different from pexelsQuery — think of supporting footage that adds visual variety. Examples: ["stock market trading floor", "money bills close up"], ["factory workers assembly line", "industrial machinery"], ["city traffic aerial view", "commuters subway station"]
IMPORTANT:'''
NEW_BROLL_PROMPT = '''- brollQueries: Array of exactly 2 specific B-roll search queries for cutaway footage that would visually complement this scene. These should be different from pexelsQuery — think of supporting footage that adds visual variety. Examples: ["stock market trading floor", "money bills close up"], ["factory workers assembly line", "industrial machinery"], ["city traffic aerial view", "commuters subway station"]
- statCallout: ONE key statistic, number, percentage, year, or measurement from this scene that would make a powerful on-screen callout box. Format as a short string: "45°C", "2%", "$4B", "1950s", "97%". If no strong stat exists, return empty string "".
- literalVisualCue: A hyper-specific 3-5 word description of the EXACT physical object or action being spoken at the most important moment in this scene. Used for ultra-precise B-roll search. Examples: "horse cart cobblestone bruges", "earthmover highway construction 1950s", "tram arriving pedestrian street", "aerial drone brussels rooftops". Must be more literal and specific than visualCue.
IMPORTANT:'''
if OLD_BROLL_PROMPT in content:
    content = content.replace(OLD_BROLL_PROMPT, NEW_BROLL_PROMPT, 1)
    changes.append("5b. Added statCallout and literalVisualCue to LLM system prompt")
else:
    print("WARNING: brollQueries prompt line not found")

# Add statCallout and literalVisualCue to JSON schema
OLD_JSON_SCHEMA = '''                    highlightWords: { type: "array", items: { type: "string" } },
                    brollQueries: { type: "array", items: { type: "string" } },
                  },
                  required: ["text", "visualCue", "pexelsQuery", "pexelsQueries", "personNames", "aiImagePrompt", "sectionTitle", "highlightWords", "brollQueries"],'''
NEW_JSON_SCHEMA = '''                    highlightWords: { type: "array", items: { type: "string" } },
                    brollQueries: { type: "array", items: { type: "string" } },
                    statCallout: { type: "string" },
                    literalVisualCue: { type: "string" },
                  },
                  required: ["text", "visualCue", "pexelsQuery", "pexelsQueries", "personNames", "aiImagePrompt", "sectionTitle", "highlightWords", "brollQueries", "statCallout", "literalVisualCue"],'''
if OLD_JSON_SCHEMA in content:
    content = content.replace(OLD_JSON_SCHEMA, NEW_JSON_SCHEMA, 1)
    changes.append("5c. Added statCallout and literalVisualCue to JSON schema")
else:
    print("WARNING: JSON schema fields not found")

# Add statCallout and literalVisualCue extraction in scene mapping
OLD_SCENE_MAPPING = '''    // Extract B-roll queries (2 specific queries for cutaway footage)
    const brollQueries = ((rawS.brollQueries as string[] | undefined) || [])
      .filter(q => typeof q === 'string' && q.trim().length > 0)
      .slice(0, 2); // max 2 queries
    return {
      ...s,
      index: i,
      duration: 0,
      pexelsQuery: primaryQuery,
      pexelsQueries: allQueries,
      personNames,
      highlightWords,
      brollQueries,'''
NEW_SCENE_MAPPING = '''    // Extract B-roll queries (2 specific queries for cutaway footage)
    const brollQueries = ((rawS.brollQueries as string[] | undefined) || [])
      .filter(q => typeof q === 'string' && q.trim().length > 0)
      .slice(0, 2); // max 2 queries
    // Extract stat callout (1 key number/stat for yellow corner box overlay)
    const statCallout = typeof rawS.statCallout === 'string' ? rawS.statCallout.trim().slice(0, 20) : '';
    // Extract literal visual cue (hyper-specific B-roll search query)
    const literalVisualCue = typeof rawS.literalVisualCue === 'string' ? rawS.literalVisualCue.trim() : '';
    return {
      ...s,
      index: i,
      duration: 0,
      pexelsQuery: literalVisualCue || primaryQuery, // use literalVisualCue as primary if available
      pexelsQueries: literalVisualCue ? [literalVisualCue, ...allQueries] : allQueries,
      personNames,
      highlightWords,
      brollQueries,
      statCallout,'''
if OLD_SCENE_MAPPING in content:
    content = content.replace(OLD_SCENE_MAPPING, NEW_SCENE_MAPPING, 1)
    changes.append("5d. Added statCallout and literalVisualCue extraction in scene mapping")
else:
    print("WARNING: scene mapping section not found")

# ─── 6. Dynamic music ducking: 8% under VO, 22% during pauses ────────────────
OLD_MUSIC_MIX = '''          `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
          `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.18,aloop=loop=-1:size=2e+09[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
          `-map "0:v" -map "[aout]" ` +
          `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`'''
NEW_MUSIC_MIX = '''          `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
          // Dynamic ducking: music drops to 8% under voiceover, rises to 22% during pauses
          // sidechaincompress: music is compressed when VO is present (attack=5ms, release=200ms)
          // This matches the reference video: VO always dominant, music swells in pauses
          `-filter_complex "[0:a]volume=1.0,asplit=2[voice][voicedet];[1:a]volume=0.22,aloop=loop=-1:size=2e+09[musicloop];[musicloop][voicedet]sidechaincompress=threshold=0.02:ratio=8:attack=5:release=200:makeup=1[music_ducked];[voice][music_ducked]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
          `-map "0:v" -map "[aout]" ` +
          `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`'''
if OLD_MUSIC_MIX in content:
    content = content.replace(OLD_MUSIC_MIX, NEW_MUSIC_MIX, 1)
    changes.append("6a. Dynamic music ducking: sidechaincompress (8% under VO, 22% in pauses)")
else:
    print("WARNING: music mix filter not found")

# Also update the fallback (no-loop) path
OLD_MUSIC_MIX_FALLBACK = '''            `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
            `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.18[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`'''
NEW_MUSIC_MIX_FALLBACK = '''            `${FFMPEG_BIN} -y -i "${concatPath}" -i "${musicPath}" ` +
            `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ` +
            `-map "0:v" -map "[aout]" ` +
            `-c:v copy -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`'''
if OLD_MUSIC_MIX_FALLBACK in content:
    content = content.replace(OLD_MUSIC_MIX_FALLBACK, NEW_MUSIC_MIX_FALLBACK, 1)
    changes.append("6b. Fallback music mix: reduced to 12% (was 18%)")
else:
    print("WARNING: fallback music mix not found")

# ─── 7. Update the comment about scene duration ───────────────────────────────
OLD_SCENE_COMMENT = '- Scenes should flow naturally — each scene is ~3-6 seconds of footage'
NEW_SCENE_COMMENT = '- Scenes should flow naturally — each scene is ~2-4 seconds of footage (reference: 1-4s hard cuts)'
if OLD_SCENE_COMMENT in content:
    content = content.replace(OLD_SCENE_COMMENT, NEW_SCENE_COMMENT, 1)
    changes.append("7. Updated scene duration comment")
else:
    print("WARNING: scene comment not found")

with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'w') as f:
    f.write(content)

print(f"\n{'='*60}")
print(f"Applied {len(changes)} changes:")
for c in changes:
    print(f"  ✓ {c}")
print('='*60)
