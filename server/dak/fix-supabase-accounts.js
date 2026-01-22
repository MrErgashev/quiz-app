#!/usr/bin/env node

/**
 * Fix: Generate and save accounts directly to Supabase
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://gwnmjpxkpbvbpthtmroj.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3bm1qcHhrcGJ2YnB0aHRtcm9qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTE1NDk5NCwiZXhwIjoyMDcwNzMwOTk0fQ.qC5hL1PDqEuulGBdrmi8cmj3kDwrcYMZG8OA1SSyVOY";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString("hex");
  return { hash, salt };
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pwd = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return pwd;
}

function generateLogin(groupName, num) {
  return `${groupName}-${String(num).padStart(3, "0")}`;
}

async function fixAccounts() {
  console.log("=".repeat(60));
  console.log("  Supabase'ga accountlarni yozish");
  console.log("=".repeat(60));
  console.log("");

  // 1. Avval jadval borligini tekshiramiz
  console.log("1️⃣  Jadvalni tekshirish...");
  const { data: tableCheck, error: tableError } = await supabase
    .from("dak_accounts")
    .select("id")
    .limit(1);

  if (tableError) {
    console.error("❌ Jadval xatosi:", tableError.message);
    console.log("");
    console.log("Ehtimol dak_accounts jadvali yaratilmagan.");
    console.log("Iltimos, 001_create_dak_tables.sql ni Supabase SQL Editor'da ishga tushiring.");
    return;
  }
  console.log("✅ Jadval mavjud");
  console.log("");

  // 2. Rosterni olish
  console.log("2️⃣  Roster'ni olish...");
  const { data: rosterData, error: rosterError } = await supabase
    .from("dak_roster")
    .select("roster_data")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rosterError || !rosterData) {
    console.error("❌ Roster topilmadi:", rosterError?.message || "Bo'sh");
    return;
  }

  const roster = rosterData.roster_data;
  console.log("✅ Roster topildi");
  console.log(`   University: ${roster.university}`);
  console.log("");

  // 3. Barcha guruhlar uchun credential yaratish
  console.log("3️⃣  Credential yaratish...");
  const allCredentials = [];
  const allAccounts = [];

  for (const program of roster.programs || []) {
    for (const group of program.groups || []) {
      console.log(`   📁 ${group.group_name} (${group.students?.length || 0} talaba)`);

      for (let i = 0; i < (group.students || []).length; i++) {
        const fullName = group.students[i];
        const login = generateLogin(group.group_name, i + 1);
        const password = generatePassword();
        const { hash, salt } = hashPassword(password);

        const account = {
          id: crypto.randomUUID(),
          login,
          password_hash: hash,
          salt,
          full_name: fullName,
          university: roster.university || "Oriental Universiteti",
          program: program.program_name,
          program_id: program.program_id,
          group: group.group_name,
          exam_date: group.exam_date,
          active: true,
          created_at: new Date().toISOString(),
        };

        allAccounts.push(account);
        allCredentials.push({ login, password, full_name: fullName, group: group.group_name });
      }
    }
  }

  console.log("");
  console.log(`   Jami: ${allAccounts.length} ta account`);
  console.log("");

  // 4. Eski accountlarni o'chirish
  console.log("4️⃣  Eski accountlarni tozalash...");
  const { error: deleteError } = await supabase
    .from("dak_accounts")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (deleteError) {
    console.error("⚠️  O'chirish xatosi:", deleteError.message);
  } else {
    console.log("✅ Tozalandi");
  }
  console.log("");

  // 5. Yangi accountlarni yozish
  console.log("5️⃣  Yangi accountlarni Supabase'ga yozish...");
  const { error: insertError } = await supabase
    .from("dak_accounts")
    .insert(allAccounts);

  if (insertError) {
    console.error("❌ Yozish xatosi:", insertError.message);
    console.log("");
    console.log("Xatolik tafsilotlari:", JSON.stringify(insertError, null, 2));
    return;
  }

  console.log("✅ Muvaffaqiyatli yozildi!");
  console.log("");

  // 6. Tekshirish
  console.log("6️⃣  Tekshirish...");
  const { data: checkData, error: checkError } = await supabase
    .from("dak_accounts")
    .select("login, full_name, group")
    .limit(5);

  if (checkError) {
    console.error("❌ Tekshirish xatosi:", checkError.message);
  } else {
    console.log("✅ Supabase'da saqlangan accountlar:");
    checkData.forEach((acc, idx) => {
      console.log(`   ${idx + 1}. ${acc.login} | ${acc.full_name}`);
    });
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("✅ TAYYOR! Endi talabalar kirishi mumkin.");
  console.log("=".repeat(60));
  console.log("");

  // 7. Barcha credentiallarni chiqarish
  console.log("📋 YANGI LOGIN VA PAROLLAR:");
  console.log("");

  let currentGroup = "";
  for (const cred of allCredentials) {
    if (cred.group !== currentGroup) {
      console.log("");
      console.log(`=== ${cred.group} ===`);
      console.log("Login\t\t\tParol\t\tF.I.Sh");
      console.log("-".repeat(70));
      currentGroup = cred.group;
    }
    console.log(`${cred.login}\t\t${cred.password}\t${cred.full_name.substring(0, 30)}`);
  }
}

fixAccounts().catch((err) => {
  console.error("💥 Xato:", err.message);
  process.exit(1);
});
