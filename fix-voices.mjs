import "dotenv/config";
import mysql from "mysql2/promise";

const realVoices = [
  { name: "Michael",      description: "American Male — natural, YouTube-style narrator",       fishAudioReferenceId: "802e3bc2b27e49c2995d23ef70e6ac89", flag: "🇺🇸", sortOrder: 1 },
  { name: "Adam",         description: "American Male — deep, authoritative",                   fishAudioReferenceId: "bf322df2096a46f18c579d0baa36f41d", flag: "🇺🇸", sortOrder: 2 },
  { name: "Heart",        description: "American Female — warm, friendly",                      fishAudioReferenceId: "536d3a5e000945adb7038665781a4aca", flag: "🇺🇸", sortOrder: 3 },
  { name: "Bella",        description: "American Female — clear, professional",                 fishAudioReferenceId: "933563129e564b19a115bedd57b7406a", flag: "🇺🇸", sortOrder: 4 },
  { name: "George",       description: "British Male — elegant, documentary-style",             fishAudioReferenceId: "179b5cc736974d96913c7849d0bb68c5", flag: "🇬🇧", sortOrder: 5 },
  { name: "Lewis",        description: "British Male — calm, authoritative narrator",           fishAudioReferenceId: "e9b134e4c0b547a3894793be502314f1", flag: "🇬🇧", sortOrder: 6 },
];

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Delete all existing voices
await conn.query("DELETE FROM voices");
console.log("Deleted all existing voices");

// Insert real voices
for (const v of realVoices) {
  await conn.query(
    "INSERT INTO voices (name, description, fishAudioReferenceId, flag, sortOrder, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())",
    [v.name, v.description, v.fishAudioReferenceId, v.flag, v.sortOrder]
  );
  console.log(`✅ Inserted: ${v.name} (${v.fishAudioReferenceId.substring(0, 8)}...)`);
}

// Verify
const [rows] = await conn.query("SELECT name, fishAudioReferenceId FROM voices ORDER BY sortOrder");
console.log("\nFinal voices in DB:");
rows.forEach(r => console.log(` - ${r.name}: ${r.fishAudioReferenceId}`));

await conn.end();
console.log("\nDone! All voices updated with real Fish Audio IDs.");
