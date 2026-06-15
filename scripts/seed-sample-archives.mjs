/**
 * Seed starter niche archives (empty — upload footage per archive in Admin).
 * Usage: DATABASE_URL=... node scripts/seed-sample-archives.mjs
 */
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const SAMPLES = [
  {
    name: "Titanic & Maritime Disasters",
    description: "Shipwrecks, ocean liners, survival at sea, and maritime history.",
    nicheTags: ["titanic", "maritime", "shipwreck", "ocean liner", "iceberg", "survival at sea"],
  },
  {
    name: "Cold War Espionage",
    description: "Spies, intelligence agencies, covert ops, and geopolitical tension.",
    nicheTags: ["cold war", "espionage", "spy", "cia", "kgb", "berlin wall", "intelligence"],
  },
  {
    name: "Silicon Valley & Tech Titans",
    description: "Startups, big tech, founders, product launches, and innovation culture.",
    nicheTags: ["silicon valley", "startup", "tech", "entrepreneur", "apple", "google", "billionaire"],
  },
  {
    name: "Ancient Egypt & Lost Civilizations",
    description: "Pyramids, pharaohs, archaeology digs, and ancient mysteries.",
    nicheTags: ["ancient egypt", "pyramid", "pharaoh", "archaeology", "mummy", "lost civilization"],
  },
  {
    name: "Formula 1 & Motorsport",
    description: "Grand prix racing, teams, drivers, crashes, and paddock drama.",
    nicheTags: ["formula 1", "f1", "motorsport", "racing", "grand prix", "ferrari", "crash"],
  },
  {
    name: "Arctic & Polar Exploration",
    description: "Expeditions, ice, explorers, survival, and polar wildlife.",
    nicheTags: ["arctic", "antarctic", "polar", "expedition", "explorer", "ice", "survival"],
  },
  {
    name: "True Crime Investigations",
    description: "Murder cases, detectives, forensics, courtrooms, and manhunts.",
    nicheTags: ["true crime", "murder", "investigation", "forensic", "detective", "courtroom"],
  },
  {
    name: "Space Race & NASA",
    description: "Rockets, astronauts, moon missions, and the race to space.",
    nicheTags: ["space race", "nasa", "astronaut", "moon landing", "rocket", "apollo", "orbit"],
  },
];

function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return base || "archive";
}

function normalizeTags(tags) {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = await mysql.createConnection(process.env.DATABASE_URL);
let created = 0;
let skipped = 0;

for (const sample of SAMPLES) {
  const slug = slugify(sample.name);
  const [rows] = await db.execute("SELECT id FROM media_archives WHERE slug = ? LIMIT 1", [slug]);
  if (rows.length > 0) {
    skipped++;
    console.log(`· skip (exists): ${sample.name}`);
    continue;
  }

  await db.execute(
    `INSERT INTO media_archives (name, slug, description, nicheTags, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
    [sample.name, slug, sample.description, JSON.stringify(normalizeTags(sample.nicheTags))]
  );
  created++;
  console.log(`✓ created: ${sample.name}`);
}

await db.end();
console.log(`Done — ${created} created, ${skipped} skipped.`);
