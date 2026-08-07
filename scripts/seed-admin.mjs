/**
 * One-time admin seed script
 * Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... SEED_ADMIN_NAME=You node scripts/seed-admin.mjs
 */
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
const name = process.env.SEED_ADMIN_NAME || "Admin";

if (!email || !password) {
  console.error(
    "Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=choose-a-strong-password node scripts/seed-admin.mjs"
  );
  process.exit(1);
}
if (password.length < 12) {
  console.error("SEED_ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const db = await mysql.createConnection(process.env.DATABASE_URL);

// Check if user already exists
const [rows] = await db.execute("SELECT id FROM users WHERE email = ?", [email]);
const hash = await bcrypt.hash(password, 12);

if (rows.length > 0) {
  // Update existing user to admin
  await db.execute(
    "UPDATE users SET role = 'admin', passwordHash = ?, name = ? WHERE email = ?",
    [hash, name, email]
  );
  console.log(`✓ Updated existing user ${email} to admin`);
} else {
  // Create new admin user
  await db.execute(
    "INSERT INTO users (email, name, passwordHash, role, loginMethod, createdAt, updatedAt) VALUES (?, ?, ?, 'admin', 'password', NOW(), NOW())",
    [email, name, hash]
  );
  console.log(`✓ Created admin account for ${email}`);
}

await db.end();
console.log("Done!");
