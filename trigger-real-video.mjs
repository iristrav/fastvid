#!/usr/bin/env node

import mysql from 'mysql2/promise';

const videoId = 600001;

async function main() {
  console.log('\n🎬 ========== TRIGGERING REAL VIDEO GENERATION ==========\n');
  console.log(`Video ID: ${videoId}`);
  console.log(`Triggering generation via database...\n`);

  try {
    const connection = await mysql.createConnection({
      host: 'switchyard.proxy.rlwy.net',
      user: 'root',
      password: 'wYDqxvVCSFsGBqDZqkRlyXnzyutusNVY',
      database: 'railway',
      port: 47894,
    });

    // Update video status to trigger generation
    console.log('📝 STEP 1: Updating video status to "generating_script"...');
    await connection.execute(
      'UPDATE videos SET status = ?, progressPercent = ?, progressStep = ?, generationStartedAt = NOW() WHERE id = ?',
      ['generating_script', 5, '🔍 Researching topic...', videoId]
    );
    console.log('✅ Status updated\n');

    // Check status
    console.log('🔍 STEP 2: Checking video status...');
    const [rows] = await connection.execute(
      'SELECT id, status, progressPercent, progressStep, prompt, videoLength FROM videos WHERE id = ?',
      [videoId]
    );

    const video = rows[0];
    if (video) {
      console.log(`✅ Video found:`);
      console.log(`  ID: ${video.id}`);
      console.log(`  Status: ${video.status}`);
      console.log(`  Progress: ${video.progressPercent}%`);
      console.log(`  Step: ${video.progressStep}`);
      console.log(`  Prompt: ${video.prompt.substring(0, 80)}...`);
      console.log(`  Duration: ${video.videoLength}\n`);
    }

    console.log('⏳ The server will pick up this video and start generation...');
    console.log('📊 Check the dashboard to monitor progress!\n');

    await connection.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
