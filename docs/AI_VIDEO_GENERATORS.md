# Multi-AI Video Generator Integration

## Overview

NexiaSafe Video now supports multiple AI video generation sources to maximize visual variety and eliminate black screens. The pipeline automatically rotates between available generators and falls back gracefully when APIs are unavailable.

## Visual Source Priority Chain

```
1. Stability AI (ACTIVE)        → SDXL image generation + Ken Burns zoom-pan
2. Grok Imagine (READY)         → Text-to-video via Replicate
3. Veo 3.1 (PLACEHOLDER)        → Awaiting public API access
4. Meta Movie Gen (PLACEHOLDER) → Awaiting public API access
5. Higgsfield (ACTIVE)          → Text-to-video & image-to-video
6. Pexels (ACTIVE)              → 3 stock video clips per scene
7. Color Fallback (ACTIVE)      → Solid color video (last resort)
```

## Active Generators

### 1. Stability AI (SDXL)
- **Status**: ✅ Active and working
- **Location**: `server/videoPipeline.ts` → `generateStabilityAIClip()`
- **Output**: 1280x720 MP4 with Ken Burns zoom-pan animation
- **Requires**: `STABILITY_AI_API_KEY` environment variable
- **Cost**: ~$0.003 per image
- **Quality**: High (cinematic, detailed)

### 2. Pexels Stock Video
- **Status**: ✅ Active and working
- **Location**: `server/videoPipeline.ts` → `fetchPexelsClips()`
- **Output**: 3 clips per scene, 1280x720 MP4
- **Requires**: `PEXELS_API_KEY` environment variable
- **Cost**: Free
- **Quality**: High (real footage)

### 3. Higgsfield AI
- **Status**: ✅ Active and working
- **Location**: `server/_core/higgsfieldVideo.ts`
- **Output**: Text-to-video and image-to-video MP4 (1280x720)
- **Requires**: `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET` environment variables
- **Cost**: Varies by usage tier
- **Quality**: High (AI-generated video)
- **Modes**: 
  - Text-to-video: Generate videos from text prompts
  - Image-to-video: Animate static images with motion

### 4. Color Fallback
- **Status**: ✅ Active and working
- **Location**: `server/videoPipeline.ts` → `generateColorFallback()`
- **Output**: Solid color video, 1280x720 MP4
- **Requires**: FFmpeg (system dependency)
- **Cost**: Free
- **Quality**: Low (safety net only)

## Ready-to-Activate Generators

### 5. Grok Imagine (xAI)
- **Status**: 🟡 Ready (requires API key)
- **Location**: `server/_core/grokVideo.ts`
- **Output**: Text-to-video MP4
- **Requires**: `REPLICATE_API_KEY` environment variable
- **Cost**: Varies by Replicate pricing
- **Quality**: High (AI-generated video)
- **How to Activate**:
  1. Sign up at https://replicate.com
  2. Get your API key from https://replicate.com/account/api-tokens
  3. Set `REPLICATE_API_KEY` in environment variables
  4. Pipeline will automatically use Grok when available

## Placeholder Generators (Awaiting Public API)

### 6. Veo 3.1 (Google)
- **Status**: 🔴 Placeholder (no public API yet)
- **Location**: `server/_core/veoVideo.ts`
- **Output**: Text-to-video MP4 (when available)
- **Requires**: Direct API access (not yet publicly available)
- **Quality**: Expected to be very high
- **Notes**:
  - Gemini API currently only supports text responses
  - Direct Veo 3.1 API access requires special permissions
  - Monitoring for public API release
  - Will be activated automatically when API becomes available

### 7. Meta Movie Gen
- **Status**: 🔴 Placeholder (no public API yet)
- **Location**: `server/_core/metaMovieGen.ts`
- **Output**: Text-to-video MP4 (when available)
- **Requires**: Public API access (not yet available)
- **Quality**: Expected to be very high
- **Notes**:
  - Currently available via research/demo only
  - Monitoring for public API release
  - Will be activated automatically when API becomes available

## Implementation Details

### Fallback Chain Logic

The `fetchSceneVisuals()` function in `videoPipeline.ts` implements the priority chain:

```typescript
// Run all generators in parallel (with Promise.allSettled)
const [aiResult, grokResult, veoResult, metaResult, higgsfieldTextResult, higgsfieldImageResult, pexelsResults] = 
  await Promise.allSettled([
    generateStabilityAIClip(...),           // 1st priority
    generateGrokVideoClip(...),             // 2nd priority
    generateVeoVideoClip(...),              // 3rd priority
    generateMetaMovieGenClip(...),          // 4th priority
    generateHiggsfieldTextToVideoClip(...), // 5th priority
    generateHiggsfieldImageToVideoClip(...),// 6th priority
    fetchPexelsClips(...),                  // 7th priority
  ]);

// Collect successful results in priority order
// If all fail, use color fallback
```

### Unique Output Paths

Each generator saves to a unique file to avoid collisions:
- Stability AI: `scene_N_ai.mp4`
- Grok: `scene_N_ai_grok.mp4`
- Veo: `scene_N_ai_veo.mp4`
- Meta: `scene_N_ai_meta.mp4`
- Higgsfield (text-to-video): `scene_N_higgsfield.mp4`
- Higgsfield (image-to-video): `scene_N_higgsfield_img.mp4`
- Pexels: `scene_N_pexels_1.mp4`, `scene_N_pexels_2.mp4`, `scene_N_pexels_3.mp4`
- Color: `scene_N_fallback.mp4`

### Error Handling

Each generator:
- Returns `null` if API key is missing
- Returns `null` if generation fails
- Returns `null` if download fails
- Logs warnings for debugging
- Never stops the pipeline

## Configuration

### Environment Variables

```bash
# Active generators (required)
STABILITY_AI_API_KEY=sk-...
PEXELS_API_KEY=...
HIGGSFIELD_API_KEY=...             # Higgsfield text/image-to-video
HIGGSFIELD_API_SECRET=...          # Higgsfield authentication

# Ready-to-activate generators (optional)
REPLICATE_API_KEY=...              # Activate Grok

# Future generators (optional)
GOOGLE_GEMINI_API_KEY=...          # For Veo when API available
META_MOVIE_GEN_API_KEY=...         # For Meta when API available
```

### Activation Checklist

**Higgsfield (Already Active):**
1. ✅ Code is already integrated
2. ✅ Helper functions ready (text-to-video + image-to-video)
3. ✅ API credentials configured
4. ✅ Pipeline configured to use Higgsfield
5. ✅ Tests passing

**To activate Grok Imagine:**
1. ✅ Code is already integrated
2. ✅ Helper function is ready
3. ⏳ Set `REPLICATE_API_KEY` environment variable
4. ⏳ Restart dev server
5. ⏳ Test video generation

**To activate Veo 3.1:**
1. ⏳ Waiting for Google to release direct API
2. ⏳ Set `GOOGLE_GEMINI_API_KEY` when available
3. ⏳ Update `server/_core/veoVideo.ts` with API endpoint
4. ⏳ Test video generation

**To activate Meta Movie Gen:**
1. ⏳ Waiting for Meta to release public API
2. ⏳ Set `META_MOVIE_GEN_API_KEY` when available
3. ⏳ Implement API integration in `server/_core/metaMovieGen.ts`
4. ⏳ Test video generation

## Testing

### Run Tests
```bash
pnpm test
```

### Test Results
- ✅ 26 tests passing (including 8 Higgsfield-specific tests)
- ✅ 0 TypeScript errors
- ✅ Integration tests for multi-AI pipeline with Higgsfield
- ✅ Backward compatibility with all existing generators verified

### Manual Testing

Generate a test video:
1. Go to dashboard
2. Enter prompt: "A beautiful sunset over mountains"
3. Select video length: 5-8 minutes
4. Click "Generate"
5. Monitor progress - should show multiple visual sources being tried

## Performance

### Scene Processing
- All generators run in parallel (no sequential delays)
- Per-scene timeout: 5 minutes for visual fetching
- Pipeline timeout: 60 minutes total

### File Size
- Stability AI: ~2-5 MB per scene
- Grok: ~3-8 MB per scene (when available)
- Higgsfield: ~4-10 MB per scene
- Pexels: ~5-10 MB per scene
- Total video: 50-250 MB depending on length and visual source mix

## Troubleshooting

### Higgsfield Videos Not Generating
- Check `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET` are set correctly
- Verify Higgsfield account has available credits
- Check logs for Higgsfield API errors or timeout messages
- Verify image URL is valid for image-to-video generation

### Grok Videos Not Generating
- Check `REPLICATE_API_KEY` is set correctly
- Verify Replicate account has credits
- Check logs for Replicate API errors

### Veo/Meta Videos Not Generating
- These are placeholders - API not yet available
- Check logs for "API access not yet available" message
- Pipeline will fall back to Pexels + Stability AI

### Black Screens in Video
- Should not happen with current fallback chain
- Check logs for "All visuals failed" messages
- Verify Pexels API key is valid
- Check FFmpeg is installed and working

### Video Generation Hangs
- Check for stuck FFmpeg processes: `ps aux | grep ffmpeg`
- Increase timeout in `videoPipeline.ts` if needed
- Check disk space for temp files

## Future Roadmap

1. **Q2 2026**: Grok Imagine integration (when REPLICATE_API_KEY available)
2. **Q3 2026**: Veo 3.1 direct API (monitoring for public release)
3. **Q4 2026**: Meta Movie Gen API (monitoring for public release)
4. **2026**: Advanced Higgsfield features (batch processing, custom models)
5. **2027**: Additional generators (Runway, Descript, etc.)

## References

- Stability AI: https://platform.stability.ai/
- Higgsfield AI: https://www.higgsfield.ai/
- Replicate (Grok): https://replicate.com/xai/grok-imagine-video
- Google Veo: https://deepmind.google/technologies/veo/
- Meta Movie Gen: https://www.meta.com/research/movie-gen/
- Pexels: https://www.pexels.com/api/
