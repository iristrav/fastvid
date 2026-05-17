#!/usr/bin/env node

/**
 * Direct Video Generation (Server-side)
 * Bypasses API authentication and directly calls the pipeline
 * This is for testing/admin purposes only
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

console.log('\n' + '='.repeat(80));
console.log('🎬 DIRECT VIDEO GENERATION (SERVER-SIDE)');
console.log('='.repeat(80));

const videoPrompt = 'The Impact of Artificial Intelligence on Modern Society - From Healthcare to Finance, AI is Revolutionizing Every Industry';
const videoLength = '5-8';
const videoType = 'documentary';

console.log(`\n📝 Prompt: "${videoPrompt}"`);
console.log(`⏱️  Duration: ${videoLength} minutes`);
console.log(`🎬 Type: ${videoType}`);
console.log(`🕐 Start Time: ${new Date().toISOString()}`);

try {
  // Import the database and pipeline functions
  const { createVideo } = await import('./db.js');
  const { generateFullVideo } = await import('./videoPipeline.js');

  console.log('\n' + '='.repeat(80));
  console.log('📊 Creating video record in database...');
  
  // Create a test user if needed (userId = 1 for admin)
  const userId = 1;
  
  // Create video record
  const videoId = await createVideo({
    userId: userId,
    prompt: videoPrompt,
    videoLength: videoLength,
    videoType: videoType,
  });

  console.log(`✅ Video record created!`);
  console.log(`\n📊 Video Details:`);
  console.log(`   Video ID: ${videoId}`);
  console.log(`   Prompt: "${videoPrompt}"`);
  console.log(`   Duration: ${videoLength} minutes`);
  console.log(`   Type: ${videoType}`);
  console.log(`   Status: pending`);
  
  console.log(`\n🚀 Starting video generation pipeline...`);
  console.log(`\n📍 Pipeline Phases:`);
  console.log(`   1. Script generation (2-3 min)`);
  console.log(`   2. Voiceover synthesis (2-5 min)`);
  console.log(`   3. Visual generation (5-10 min)`);
  console.log(`   4. Scene assembly (5-10 min)`);
  console.log(`   5. Audio mixing (1-3 min)`);
  console.log(`   6. Effects & subtitles (3-5 min)`);
  console.log(`   7. Final export (2-3 min)`);
  
  console.log(`\n⏳ Estimated total time: 20-38 minutes`);
  
  // Start the pipeline (non-blocking)
  generateFullVideo(videoId, videoPrompt, videoLength, videoType).catch(err => {
    console.error(`\n❌ Pipeline error:`, err.message);
  });

  console.log(`\n✅ Video generation started!`);
  console.log(`\n📺 In the Dashboard:`);
  console.log(`   1. Go to Videos section`);
  console.log(`   2. Look for Video ID: ${videoId}`);
  console.log(`   3. Watch the status update in real-time`);
  console.log(`   4. Status progression:`);
  console.log(`      - pending → generating_script`);
  console.log(`      - → generating_voiceover`);
  console.log(`      - → generating_visuals`);
  console.log(`      - → generating_effects`);
  console.log(`      - → completed`);
  
  console.log('\n' + '='.repeat(80));
  console.log(`✅ VIDEO GENERATION STARTED - Video ID: ${videoId}`);
  console.log('='.repeat(80) + '\n');

} catch (error) {
  console.error('\n❌ Error:');
  console.error(error.message);
  console.error(error.stack);
  process.exit(1);
}
