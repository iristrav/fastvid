/**
 * One-time admin seed script
 * Usage: node scripts/seed-admin.mjs
 */
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const email = "Iris.travaille@hotmail.com";
const password = "Olafenabu1!";
const name = "Iris";

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
