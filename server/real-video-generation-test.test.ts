import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createConnection, Connection } from "mysql2/promise";

describe("REAL VIDEO GENERATION TEST", () => {
  let db: Connection;
  const videoId = 600001;

  beforeAll(async () => {
    db = await createConnection(process.env.DATABASE_URL || "mysql://root:wYDqxvVCSFsGBqDZqkRlyXnzyutusNVY@switchyard.proxy.rlwy.net:47894/railway");
    console.log("\n🎬 ========== REAL VIDEO GENERATION TEST ==========\n");
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it("Monitor video generation progress", async () => {
    console.log("📊 Monitoring video 600001 generation...\n");

    let lastStatus = "";
    let lastPercent = 0;
    let startTime = Date.now();
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes max

    while (Date.now() - startTime < maxWaitTime) {
      const [rows] = await db.execute(
        "SELECT status, progressPercent, progressStep, script, voiceoverUrl, videoUrl, errorMessage FROM videos WHERE id = ?",
        [videoId]
      );

      const video = (rows as any)[0];

      if (!video) {
        console.log("❌ Video not found!");
        throw new Error("Video not found");
      }

      const percent = video.progressPercent || 0;

      // Log updates
      if (video.status !== lastStatus || percent !== lastPercent) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`[${elapsed}s] Status: ${video.status} | Progress: ${percent}% | Step: ${video.progressStep || "N/A"}`);
        lastStatus = video.status;
        lastPercent = percent;
      }

      // Check if completed
      if (video.status === "completed") {
        console.log("\n✅ VIDEO GENERATION COMPLETED!\n");
        console.log("📊 Final Results:");
        console.log(`  Status: ${video.status}`);
        console.log(`  Progress: ${percent}%`);
        console.log(`  Script: ${video.script ? `✅ ${video.script.length} chars` : "❌"}`);
        console.log(`  Voiceover: ${video.voiceoverUrl ? "✅" : "❌"}`);
        console.log(`  Video: ${video.videoUrl ? "✅" : "❌"}`);

        expect(video.status).toBe("completed");
        expect(video.script).toBeTruthy();
        expect(video.voiceoverUrl).toBeTruthy();
        expect(video.videoUrl).toBeTruthy();
        return;
      }

      // Check for errors
      if (video.status === "failed") {
        console.log(`\n❌ VIDEO GENERATION FAILED!\n`);
        console.log(`Error: ${video.errorMessage}`);
        throw new Error(`Video generation failed: ${video.errorMessage}`);
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    throw new Error(`Video generation timed out after 5 minutes`);
  }, { timeout: 6 * 60 * 1000 }); // 6 minute test timeout
});
