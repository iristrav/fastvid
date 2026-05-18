import mysql from 'mysql2/promise';

const videoId = 600001;
let lastPercent = 0;

async function checkProgress() {
  try {
    const connection = await mysql.createConnection({
      host: 'switchyard.proxy.rlwy.net',
      user: 'root',
      password: 'wYDqxvVCSFsGBqDZqkRlyXnzyutusNVY',
      database: 'railway',
      port: 47894,
    });

    const [rows] = await connection.execute(
      'SELECT status, progressPercent, progressStep, script, voiceoverUrl, videoUrl, errorMessage FROM videos WHERE id = ?',
      [videoId]
    );

    const video = rows[0];
    if (!video) {
      console.log('❌ Video not found');
      await connection.end();
      return;
    }

    const percent = video.progressPercent || 0;
    if (percent !== lastPercent || video.progressStep) {
      console.log(`\n⏳ [${new Date().toLocaleTimeString()}] Video ${videoId}`);
      console.log(`  Status: ${video.status}`);
      console.log(`  Progress: ${percent}%`);
      console.log(`  Step: ${video.progressStep || 'N/A'}`);
      console.log(`  Script: ${video.script ? '✅' : '❌'}`);
      console.log(`  Voiceover: ${video.voiceoverUrl ? '✅' : '❌'}`);
      console.log(`  Video: ${video.videoUrl ? '✅' : '❌'}`);
      if (video.errorMessage) console.log(`  Error: ${video.errorMessage}`);
      lastPercent = percent;
    }

    await connection.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

console.log('🎬 Monitoring video 600001 generation...\n');
setInterval(checkProgress, 2000);
