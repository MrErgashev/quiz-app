#!/usr/bin/env node

/**
 * Debug script to diagnose DAK authentication issues
 */

const crypto = require("crypto");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// Agar .env faylda bo'lmasa, qo'lda kiriting:
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gwnmjpxkpbvbpthtmroj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3bm1qcHhrcGJ2YnB0aHRtcm9qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTE1NDk5NCwiZXhwIjoyMDcwNzMwOTk0fQ.qC5hL1PDqEuulGBdrmi8cmj3kDwrcYMZG8OA1SSyVOY";

if (!SUPABASE_URL || SUPABASE_URL === "YOUR_SUPABASE_URL_HERE") {
  console.error("❌ SUPABASE_URL kerak!");
  console.error("");
  console.error("Iltimos, debug-auth.js faylida yoki .env faylida quyidagilarni o'rnating:");
  console.error("  SUPABASE_URL=https://your-project.supabase.co");
  console.error("  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key");
  console.error("");
  console.error("Yoki to'g'ridan-to'g'ri shu faylda o'zgartiring (14-15 qatorlar)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function verifyPassword(password, storedHash, storedSalt) {
  const hash = crypto.scryptSync(password, storedSalt, KEY_LENGTH, SCRYPT_OPTIONS);
  const storedHashBuffer = Buffer.from(storedHash, "hex");
  return crypto.timingSafeEqual(hash, storedHashBuffer);
}

async function debugAuth() {
  console.log("=".repeat(60));
  console.log("  DAK Authentication Debug");
  console.log("=".repeat(60));
  console.log("");

  // 1. Check accounts in Supabase
  console.log("1️⃣  Checking accounts in Supabase...");
  const { data: accounts, error } = await supabase
    .from("dak_accounts")
    .select("id, login, full_name, group, exam_date, active, password_hash, salt")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ Error fetching accounts:", error.message);
    return;
  }

  if (!accounts || accounts.length === 0) {
    console.log("⚠️  No accounts found in Supabase!");
    console.log("");
    console.log("Possible solutions:");
    console.log("  1. Generate credentials from teacher dashboard");
    console.log("  2. Check if SUPABASE_URL and SUPABASE_KEY are correct");
    return;
  }

  console.log(`✅ Found ${accounts.length} accounts`);
  console.log("");

  // Display accounts
  console.log("📋 Sample accounts:");
  accounts.slice(0, 5).forEach((acc, idx) => {
    console.log(`   ${idx + 1}. Login: ${acc.login} | Name: ${acc.full_name} | Group: ${acc.group}`);
    console.log(`      Active: ${acc.active} | Has hash: ${!!acc.password_hash} | Has salt: ${!!acc.salt}`);
  });
  console.log("");

  // 2. Test password verification with first account
  console.log("2️⃣  Testing password verification...");
  const testAccount = accounts[0];

  if (!testAccount.password_hash || !testAccount.salt) {
    console.log("❌ Account missing password_hash or salt!");
    console.log("   This means credentials were not properly generated.");
    return;
  }

  console.log(`   Testing account: ${testAccount.login}`);
  console.log(`   Hash length: ${testAccount.password_hash.length}`);
  console.log(`   Salt length: ${testAccount.salt.length}`);

  // Try to verify with a dummy password to see the mechanism works
  try {
    const dummyResult = verifyPassword("TESTPASS", testAccount.password_hash, testAccount.salt);
    console.log(`   ✅ Password verification mechanism works (dummy test: ${dummyResult})`);
  } catch (err) {
    console.log(`   ❌ Password verification failed: ${err.message}`);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("✅ Debug completed");
  console.log("");
  console.log("📋 Key findings:");
  console.log(`   - Total accounts: ${accounts.length}`);
  console.log(`   - All have password hashes: ${accounts.every(a => a.password_hash)}`);
  console.log(`   - All have salts: ${accounts.every(a => a.salt)}`);
  console.log(`   - All active: ${accounts.filter(a => a.active !== false).length}/${accounts.length}`);
  console.log("");

  if (!accounts.every(a => a.password_hash && a.salt)) {
    console.log("⚠️  PROBLEM DETECTED:");
    console.log("   Some accounts are missing password_hash or salt!");
    console.log("   Solution: Regenerate credentials from teacher dashboard");
    console.log("");
  }
}

debugAuth().catch(err => {
  console.error("💥 Fatal error:", err.message);
  process.exit(1);
});
