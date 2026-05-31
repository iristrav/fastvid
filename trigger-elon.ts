/**
 * Direct trigger script for Elon Musk video generation
 * Run with: npx tsx trigger-elon.ts
 */
import { createVideo } from "./server/db";
import { generateFullVideo } from "./server/routers";

async function main() {
  console.log('[Trigger] Creating Elon Musk video...');
  
  const videoId = await createVideo({
    userId: 1,
    prompt: 'Elon Musk: The Visionary Behind Tesla, SpaceX, and the Future of Humanity',
    videoLength: '5-8',
    videoType: 'documentary',
  });
  
  console.log(`[Trigger] Video created with ID: ${videoId}`);
  console.log('[Trigger] Starting pipeline...');
  
  await generateFullVideo(
    videoId,
    'Elon Musk: The Visionary Behind Tesla, SpaceX, and the Future of Humanity',
    '5-8',
    'documentary',
    undefined, // voiceId (use default)
    undefined, // customVoiceoverUrl
    false,     // enableSubtitles = false (disabled per user request)
  );
  
  console.log(`[Trigger] Pipeline completed for video ${videoId}`);
}

main().catch(console.error);
