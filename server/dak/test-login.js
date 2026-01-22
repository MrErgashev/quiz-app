#!/usr/bin/env node

/**
 * Test script to verify login works
 */

const crypto = require("crypto");
const path = require("path");
const { createDakStore } = require("./store");

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function verifyPassword(password, storedHash, storedSalt) {
  const hash = crypto.scryptSync(password, storedSalt, KEY_LENGTH, SCRYPT_OPTIONS);
  const storedHashBuffer = Buffer.from(storedHash, "hex");
  return crypto.timingSafeEqual(hash, storedHashBuffer);
}

async function testLogin() {
  console.log("=".repeat(60));
  console.log("  Test Login");
  console.log("=".repeat(60));
  console.log("");

  const dataDir = path.join(__dirname, "../../data");
  const store = createDakStore({ dataDir, supabase: null });

  // Test credentials from generation
  const testLogin = "IQTK-102-001";
  const testPassword = "V7SEHK2T"; // from the generation output

  console.log(`🔐 Testing login: ${testLogin}`);
  console.log(`   Password: ${testPassword}`);
  console.log("");

  // Get account
  const account = await store.getAccountByLogin(testLogin);

  if (!account) {
    console.log("❌ Account not found!");
    console.log("   This means the account was not saved properly.");
    return;
  }

  console.log("✅ Account found!");
  console.log(`   Full name: ${account.full_name}`);
  console.log(`   Group: ${account.group}`);
  console.log(`   Active: ${account.active}`);
  console.log("");

  // Verify password
  console.log("🔑 Verifying password...");
  try {
    const valid = verifyPassword(testPassword, account.password_hash, account.salt);

    if (valid) {
      console.log("✅ Password is CORRECT!");
      console.log("   Login would succeed!");
    } else {
      console.log("❌ Password is INCORRECT!");
      console.log("   This means password hashing has an issue.");
    }
  } catch (err) {
    console.log("❌ Password verification failed:", err.message);
  }

  console.log("");
  console.log("=".repeat(60));
}

testLogin().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  console.error(err);
  process.exit(1);
});
