#!/usr/bin/env node

/**
 * DAK Local Data to Supabase Migration Utility
 *
 * Purpose: Migrate existing local JSON files to Supabase tables
 * Run this ONCE before deploying to production
 *
 * Usage:
 *   node server/dak/migrate-local-to-supabase.js
 *
 * Prerequisites:
 *   1. Create Supabase tables using 001_create_dak_tables.sql
 *   2. Set environment variables:
 *      - SUPABASE_URL
 *      - SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
 *
 * What it migrates:
 *   - data/dak_banks.json → dak_banks table
 *   - data/dak_roster.json → dak_roster table
 *   - data/dak_accounts.json → dak_accounts table
 *   - data/dak_attempts/*.json → dak_attempts table
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Load environment variables
require("dotenv").config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Error: Missing environment variables");
  console.error("   Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  console.error("");
  console.error("   Example:");
  console.error("   export SUPABASE_URL='https://your-project.supabase.co'");
  console.error("   export SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dataDir = path.join(__dirname, "../../data");

console.log("=".repeat(60));
console.log("  DAK Local Data → Supabase Migration");
console.log("=".repeat(60));
console.log("");
console.log("📂 Data directory:", dataDir);
console.log("🔗 Supabase URL:", SUPABASE_URL);
console.log("");

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`   ⚠️  Failed to read ${path.basename(filePath)}:`, err.message);
    return null;
  }
}

async function migrate() {
  let totalMigrated = 0;
  let errors = 0;

  // =========================
  // 1. Migrate dak_banks.json
  // =========================
  console.log("1️⃣  Migrating question banks...");
  const banksFile = path.join(dataDir, "dak_banks.json");
  const banks = safeReadJson(banksFile);

  if (banks && Array.isArray(banks) && banks.length > 0) {
    try {
      const rows = banks.map(b => ({
        bank_id: b.bank_id,
        subject_name: b.subject_name || "",
        questions: b.questions || [],
        created_at: b.created_at || new Date().toISOString()
      }));

      // Check if banks already exist
      const { data: existing } = await supabase
        .from("dak_banks")
        .select("bank_id");

      if (existing && existing.length > 0) {
        console.log(`   ⚠️  Found ${existing.length} existing banks in Supabase`);
        console.log(`   ⏭️  Skipping banks migration (already exists)`);
      } else {
        const { error } = await supabase.from("dak_banks").insert(rows);
        if (error) throw error;
        console.log(`   ✅ Migrated ${banks.length} question banks`);
        totalMigrated += banks.length;
      }
    } catch (err) {
      console.error(`   ❌ Error:`, err.message);
      errors++;
    }
  } else {
    console.log("   ⏭️  No banks found to migrate");
  }

  console.log("");

  // =========================
  // 2. Migrate dak_roster.json
  // =========================
  console.log("2️⃣  Migrating student roster...");
  const rosterFile = path.join(dataDir, "dak_roster.json");
  const roster = safeReadJson(rosterFile);

  if (roster && typeof roster === "object") {
    try {
      // Check if roster already exists
      const { data: existing } = await supabase
        .from("dak_roster")
        .select("id")
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`   ⚠️  Roster already exists in Supabase`);
        console.log(`   ⏭️  Skipping roster migration`);
      } else {
        const { error } = await supabase.from("dak_roster").insert({
          roster_data: roster,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;

        const studentCount = (roster.programs || []).reduce((sum, p) =>
          sum + (p.groups || []).reduce((s, g) => s + (g.students || []).length, 0), 0);
        console.log(`   ✅ Migrated roster with ${studentCount} students`);
        totalMigrated++;
      }
    } catch (err) {
      console.error(`   ❌ Error:`, err.message);
      errors++;
    }
  } else {
    console.log("   ⏭️  No roster found to migrate");
  }

  console.log("");

  // =========================
  // 3. Migrate dak_accounts.json
  // =========================
  console.log("3️⃣  Migrating student accounts...");
  const accountsFile = path.join(dataDir, "dak_accounts.json");
  const accounts = safeReadJson(accountsFile);

  if (accounts && Array.isArray(accounts) && accounts.length > 0) {
    try {
      // Check if accounts already exist
      const { data: existing } = await supabase
        .from("dak_accounts")
        .select("login");

      if (existing && existing.length > 0) {
        console.log(`   ⚠️  Found ${existing.length} existing accounts in Supabase`);
        console.log(`   ⏭️  Skipping accounts migration (already exists)`);
      } else {
        const { error } = await supabase.from("dak_accounts").insert(accounts);
        if (error) throw error;
        console.log(`   ✅ Migrated ${accounts.length} student accounts`);
        totalMigrated += accounts.length;
      }
    } catch (err) {
      console.error(`   ❌ Error:`, err.message);
      errors++;
    }
  } else {
    console.log("   ⏭️  No accounts found to migrate");
  }

  console.log("");

  // =========================
  // 4. Migrate dak_attempts/*.json
  // =========================
  console.log("4️⃣  Migrating exam attempts...");
  const attemptsDir = path.join(dataDir, "dak_attempts");

  if (fs.existsSync(attemptsDir)) {
    try {
      const files = fs.readdirSync(attemptsDir).filter(f => f.endsWith(".json"));
      const attempts = [];

      for (const fname of files) {
        const attempt = safeReadJson(path.join(attemptsDir, fname));
        if (attempt) {
          attempts.push({
            attempt_id: attempt.attempt_id,
            university: attempt.university || "Oriental Universiteti",
            program_id: attempt.program_id,
            program_name: attempt.program_name,
            group_name: attempt.group_name,
            student_fullname: attempt.student_fullname,
            exam_date: attempt.exam_date,
            started_at: attempt.started_at,
            finished_at: attempt.finished_at || null,
            updated_at: attempt.updated_at || new Date().toISOString(),
            duration_minutes: attempt.duration_minutes,
            total_questions: attempt.total_questions,
            points_per_question: attempt.points_per_question,
            questions: attempt.questions || [],
            answers: attempt.answers || {},
            correct_count: attempt.correct_count || null,
            score_points: attempt.score_points || null
          });
        }
      }

      if (attempts.length > 0) {
        // Check if attempts already exist
        const { data: existing } = await supabase
          .from("dak_attempts")
          .select("attempt_id");

        if (existing && existing.length > 0) {
          console.log(`   ⚠️  Found ${existing.length} existing attempts in Supabase`);
          console.log(`   ⏭️  Skipping attempts migration (already exists)`);
        } else {
          // Insert in batches of 100 (Supabase limit)
          const batchSize = 100;
          for (let i = 0; i < attempts.length; i += batchSize) {
            const batch = attempts.slice(i, i + batchSize);
            const { error } = await supabase.from("dak_attempts").insert(batch);
            if (error) throw error;
            console.log(`   📦 Migrated batch ${Math.floor(i / batchSize) + 1} (${batch.length} attempts)`);
          }
          console.log(`   ✅ Migrated ${attempts.length} exam attempts`);
          totalMigrated += attempts.length;
        }
      } else {
        console.log("   ⏭️  No attempts found to migrate");
      }
    } catch (err) {
      console.error(`   ❌ Error:`, err.message);
      errors++;
    }
  } else {
    console.log("   ⏭️  No attempts directory found");
  }

  console.log("");
  console.log("=".repeat(60));

  if (errors === 0) {
    console.log("✅ Migration completed successfully!");
    console.log(`   Total items migrated: ${totalMigrated}`);
  } else {
    console.log("⚠️  Migration completed with errors");
    console.log(`   Total items migrated: ${totalMigrated}`);
    console.log(`   Errors encountered: ${errors}`);
  }

  console.log("");
  console.log("📋 Next steps:");
  console.log("   1. Verify data in Supabase Table Editor");
  console.log("   2. Test application with new storage");
  console.log("   3. Deploy to Render");
  console.log("=".repeat(60));
}

// Run migration
migrate().catch(err => {
  console.error("");
  console.error("💥 Fatal error:", err.message);
  console.error("");
  process.exit(1);
});
