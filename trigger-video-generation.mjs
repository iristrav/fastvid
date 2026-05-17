#!/usr/bin/env node

/**
 * Trigger Real Video Generation
 * Creates a 6-8 minute video through the API and stores it in the database
 */

import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000/api/trpc';

const videoPrompt = 'The Impact of Artificial Intelligence on Modern Society - From Healthcare to Finance, AI is Revolutionizing Every Industry';
const videoLength = '5-8'; // 5-8 minutes
const videoType = 'documentary';

console.log('\n' + '='.repeat(80));
console.log('🎬 TRIGGERING REAL VIDEO GENERATION');
console.log('='.repeat(80));
console.log(`\n📝 Prompt: "${videoPrompt}"`);
console.log(`⏱️  Duration: ${videoLength} minutes`);
console.log(`🎬 Type: ${videoType}`);
console.log(`🕐 Start Time: ${new Date().toISOString()}`);
console.log('\n' + '='.repeat(80));

try {
  // Call the generateVideo endpoint
  console.log('\n📤 Calling API: admin.generateVideo');
  console.log(`   Endpoint: ${API_URL}/admin.generateVideo`);
  
  const response = await fetch(`${API_URL}/admin.generateVideo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      json: {
        prompt: videoPrompt,
        videoLength: videoLength,
        videoType: videoType,
      },
    }),
  });

  const data = await response.json();
  
  if (data.result && data.result.data) {
    const videoId = data.result.data.json.videoId;
    
    console.log(`\n✅ Video generation triggered successfully!`);
    console.log(`\n📊 Video Details:`);
    console.log(`   Video ID: ${videoId}`);
    console.log(`   Prompt: "${videoPrompt}"`);
    console.log(`   Duration: ${videoLength} minutes`);
    console.log(`   Type: ${videoType}`);
    console.log(`   Status: pending (will start generating)`);
    console.log(`\n📍 Phases:`);
    console.log(`   1. Script generation (2-3 min)`);
    console.log(`   2. Voiceover synthesis (2-5 min)`);
    console.log(`   3. Visual generation (5-10 min)`);
    console.log(`   4. Scene assembly (5-10 min)`);
    console.log(`   5. Audio mixing (1-3 min)`);
    console.log(`   6. Effects & subtitles (3-5 min)`);
    console.log(`   7. Final export (2-3 min)`);
    console.log(`\n⏳ Estimated total time: 20-38 minutes`);
    console.log(`\n🔍 Check the dashboard to monitor progress:`);
    console.log(`   - Status will change from "pending" to "generating_script"`);
    console.log(`   - Then "generating_voiceover"`);
    console.log(`   - Then "generating_visuals"`);
    console.log(`   - Finally "completed" when done`);
    console.log(`\n📺 In the Dashboard:`);
    console.log(`   1. Go to Videos section`);
    console.log(`   2. Look for Video ID: ${videoId}`);
    console.log(`   3. Watch the status update in real-time`);
    console.log(`   4. Once completed, click to preview or download`);
    
    console.log('\n' + '='.repeat(80));
    console.log(`✅ VIDEO GENERATION STARTED - Video ID: ${videoId}`);
    console.log('='.repeat(80) + '\n');
    
  } else {
    console.error('\n❌ Error response from API:');
    console.error(JSON.stringify(data, null, 2));
  }
  
} catch (error) {
  console.error('\n❌ Error triggering video generation:');
  console.error(error.message);
  process.exit(1);
}
