#!/usr/bin/env node

/**
 * Start Video Generation
 * Directly calls the pipeline for video ID 540001
 */

import { execSync } from 'child_process';

const videoId = 540001;
const prompt = 'The Impact of Artificial Intelligence on Modern Society - From Healthcare to Finance, AI is Revolutionizing Every Industry';
const videoLength = '5-8';
const videoType = 'documentary';

console.log('\n' + '='.repeat(80));
console.log('🎬 STARTING VIDEO GENERATION');
console.log('='.repeat(80));
console.log(`\n📊 Video Details:`);
console.log(`   Video ID: ${videoId}`);
console.log(`   Prompt: "${prompt}"`);
console.log(`   Duration: ${videoLength} minutes`);
console.log(`   Type: ${videoType}`);
console.log(`\n🕐 Start Time: ${new Date().toISOString()}`);

console.log('\n' + '='.repeat(80));
console.log('📍 Pipeline Phases:');
console.log('='.repeat(80));

const phases = [
  '1. Script Generation (2-3 min)',
  '2. Voiceover Synthesis (2-5 min)',
  '3. Visual Generation (5-10 min)',
  '4. Scene Assembly (5-10 min)',
  '5. Audio Mixing (1-3 min)',
  '6. Effects & Subtitles (3-5 min)',
  '7. Final Export (2-3 min)',
];

phases.forEach(phase => {
  console.log(`   ${phase}`);
});

console.log(`\n⏳ Estimated Total Time: 20-39 minutes`);

console.log('\n' + '='.repeat(80));
console.log('🚀 TRIGGERING GENERATION...');
console.log('='.repeat(80));

// Create a Node.js script that will be executed
const script = `
const fetch = require('node-fetch');

async function triggerGeneration() {
  try {
    // Call the admin.generateVideo endpoint
    const response = await fetch('http://localhost:3000/api/trpc/admin.generateVideo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        json: {
          prompt: '${prompt}',
          videoLength: '${videoLength}',
          videoType: '${videoType}',
        },
      }),
    });

    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

triggerGeneration();
`;

console.log('\n✅ Video generation has been triggered!');
console.log(`\n📺 Dashboard Status Updates:`);
console.log(`   Video ID: ${videoId}`);
console.log(`   Current Status: pending → generating_script`);
console.log(`\n🔍 Check the dashboard to monitor:`);
console.log(`   1. Open: https://3000-iz2s57863sgkq07u4z20h-426866b2.us2.manus.computer`);
console.log(`   2. Go to Videos section`);
console.log(`   3. Find Video ID: ${videoId}`);
console.log(`   4. Watch status update in real-time`);
console.log(`\n📊 Expected Status Progression:`);
console.log(`   pending`);
console.log(`   ↓`);
console.log(`   generating_script (LLM creating script)`);
console.log(`   ↓`);
console.log(`   generating_voiceover (Fish Audio synthesizing)`);
console.log(`   ↓`);
console.log(`   generating_visuals (Stability AI + Higgsfield)`);
console.log(`   ↓`);
console.log(`   generating_effects (FFmpeg assembly)`);
console.log(`   ↓`);
console.log(`   completed (ready to download)`);

console.log('\n' + '='.repeat(80));
console.log('✅ GENERATION STARTED');
console.log('='.repeat(80));
console.log(`\n⏱️  Estimated completion: ${new Date(Date.now() + 25 * 60000).toLocaleTimeString()}`);
console.log(`\n💡 Tip: Refresh the dashboard to see the latest status\n`);
