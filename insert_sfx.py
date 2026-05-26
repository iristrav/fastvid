#!/usr/bin/env python3
"""Insert generateSFX function before concatenateScenesWithMusic in videoPipeline.ts"""

import re

with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'r') as f:
    content = f.read()

SFX_FUNCTION = '''
// ─── 6b. Sound Effects (SFX) Generation ──────────────────────────────────────
// Generates camera shutter, whoosh, and impact sounds using FFmpeg lavfi synthesis.
// These are mixed into the final audio at low volume for Vidrush-style energy.
async function generateSFX(
  type: 'shutter' | 'whoosh' | 'impact',
  workDir: string
): Promise<string> {
  const outputPath = path.join(workDir, `sfx_${type}.mp3`);
  try {
    let cmd = '';
    if (type === 'shutter') {
      // Camera shutter: short high-freq click (2kHz, 0.05s) + mechanical thud (200Hz, 0.08s)
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.05" ` +
        `-f lavfi -i "sine=frequency=200:duration=0.08" ` +
        `-filter_complex "[0]volume=0.6,aecho=0.8:0.3:10:0.2[click];[1]volume=0.4,lowpass=f=400[thud];[click][thud]amix=inputs=2:duration=longest[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else if (type === 'whoosh') {
      // Whoosh: swept sine 200Hz→2000Hz over 0.2s for transition sound
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=200:duration=0.2" ` +
        `-f lavfi -i "sine=frequency=2000:duration=0.2" ` +
        `-filter_complex "[0]volume=0.5,aecho=0.7:0.5:20:0.3[low];[1]volume=0.3,aecho=0.7:0.5:15:0.2[high];[low][high]amix=inputs=2:duration=longest,atempo=1.5[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    } else {
      // Impact: low thud (80Hz, 0.15s) with decay
      cmd = `${FFMPEG_BIN} -y ` +
        `-f lavfi -i "sine=frequency=80:duration=0.15" ` +
        `-filter_complex "[0]volume=0.7,aecho=0.9:0.6:30:0.4,lowpass=f=300[sfx]" ` +
        `-map "[sfx]" -c:a libmp3lame -b:a 128k "${outputPath}"`;
    }
    await withTimeout(exec(cmd), 10_000, `SFX generation: ${type}`);
    return outputPath;
  } catch (err) {
    console.warn(`[Pipeline] SFX generation failed for ${type}:`, err);
    // Return empty audio as fallback
    await exec(`${FFMPEG_BIN} -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 0.1 -c:a libmp3lame -b:a 64k "${outputPath}"`).catch(() => {});
    return outputPath;
  }
}

'''

MARKER = '// ─── 7. Final Concatenation + Music Mix ───────────────────────────────────────'

if MARKER in content:
    content = content.replace(MARKER, SFX_FUNCTION + MARKER)
    with open('/home/ubuntu/nexiasafe-video/server/videoPipeline.ts', 'w') as f:
        f.write(content)
    print("SUCCESS: SFX function inserted")
else:
    print("ERROR: Marker not found")
    print("Looking for:", repr(MARKER[:60]))
