import { generateVideo } from './server/videoPipeline.ts';

const testPrompt = "Rumors about Kylie Jenner";
const videoDuration = 6; // 5-8 minutes

console.log(`[Test] Starting video generation for: "${testPrompt}"`);
console.log(`[Test] Video duration: ${videoDuration} minutes`);
console.log(`[Test] Timestamp: ${new Date().toISOString()}`);

try {
  const result = await generateVideo({
    topic: testPrompt,
    videoLength: videoDuration,
    includeSubtitles: true,
  });
  
  console.log(`[Test] ✅ Video generation completed!`);
  console.log(`[Test] Output: ${result.videoPath}`);
  console.log(`[Test] File size: ${result.fileSize} bytes`);
  console.log(`[Test] Duration: ${result.actualDuration} seconds`);
} catch (err) {
  console.error(`[Test] ❌ Video generation failed:`, err);
}
