#!/usr/bin/env node

/**
 * Test: O'qituvchi UI orqali credential yaratishni simulyatsiya qilish
 */

const crypto = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { createDakStore } = require("./store");

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

function verifyPassword(password, storedHash, storedSalt) {
  const hash = crypto.scryptSync(password, storedSalt, KEY_LENGTH, SCRYPT_OPTIONS);
  const storedHashBuffer = Buffer.from(storedHash, "hex");
  return crypto.timingSafeEqual(hash, storedHashBuffer);
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

async function testUIGenerate() {
  console.log("=".repeat(60));
  console.log("  O'qituvchi UI Credential Yaratish Testi");
  console.log("=".repeat(60));
  console.log("");

  const dataDir = path.join(__dirname, "../../data");
  const store = createDakStore({ dataDir, supabase });

  // Test guruhi
  const group = "IQTK-102";
  const exam_date = "2026-01-22";

  console.log(`1️⃣  Guruh: ${group}, Sana: ${exam_date}`);
  console.log("");

  // Roster'dan talabalarni olish
  const roster = await store.getRoster();
  let targetGroup = null;
  let targetProgram = null;

  for (const program of roster.programs || []) {
    for (const g of program.groups || []) {
      if (g.group_name === group && g.exam_date === exam_date) {
        targetGroup = g;
        targetProgram = program;
        break;
      }
    }
    if (targetGroup) break;
  }

  if (!targetGroup) {
    console.error("❌ Guruh topilmadi!");
    return;
  }

  const students = targetGroup.students || [];
  console.log(`2️⃣  ${students.length} ta talaba topildi`);
  console.log("");

  // Credential yaratish (routes.js logikasi)
  console.log("3️⃣  Credential yaratish...");
  const accounts = await store.getAccounts();
  const createdCredentials = [];

  for (let i = 0; i < students.length; i++) {
    const fullName = students[i];
    const login = generateLogin(group, i + 1);
    const password = generatePassword();
    const { hash, salt } = hashPassword(password);

    const accountId = crypto.randomUUID();

    const newAccount = {
      id: accountId,
      login,
      password_hash: hash,
      salt,
      full_name: fullName,
      university: roster.university || "Oriental Universiteti",
      program: targetProgram.program_name,
      program_id: targetProgram.program_id,
      group,
      exam_date,
      active: true,
      created_at: new Date().toISOString(), // FIXED: was createdAt
    };

    const existingIdx = accounts.findIndex(
      (a) => a.login === login || (a.group === group && a.full_name === fullName && a.exam_date === exam_date)
    );

    if (existingIdx >= 0) {
      accounts[existingIdx] = newAccount;
    } else {
      accounts.push(newAccount);
    }

    createdCredentials.push({
      login,
      password,
      full_name: fullName,
    });
  }

  console.log(`   ${createdCredentials.length} ta credential yaratildi`);
  console.log("");

  // Supabase'ga saqlash
  console.log("4️⃣  Supabase'ga saqlash...");
  try {
    await store.setAccounts(accounts);
    console.log("✅ Muvaffaqiyatli saqlandi!");
  } catch (err) {
    console.error("❌ Saqlash xatosi:", err.message);
    return;
  }
  console.log("");

  // Tekshirish - birinchi talaba bilan login qilish
  console.log("5️⃣  Login tekshirish...");
  const testCred = createdCredentials[0];
  console.log(`   Login: ${testCred.login}`);
  console.log(`   Parol: ${testCred.password}`);

  const account = await store.getAccountByLogin(testCred.login);
  if (!account) {
    console.error("❌ Account topilmadi Supabase'da!");
    return;
  }

  console.log("✅ Account Supabase'da topildi");

  const valid = verifyPassword(testCred.password, account.password_hash, account.salt);
  if (valid) {
    console.log("✅ Parol TO'G'RI! Login muvaffaqiyatli bo'ladi!");
  } else {
    console.log("❌ Parol NOTO'G'RI!");
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("✅ TEST MUVAFFAQIYATLI O'TDI!");
  console.log("=".repeat(60));
  console.log("");
  console.log("Yangi parollar:");
  console.log("Login\t\t\tParol");
  console.log("-".repeat(40));
  createdCredentials.forEach(c => {
    console.log(`${c.login}\t\t${c.password}`);
  });
}

testUIGenerate().catch(err => {
  console.error("💥 Xato:", err.message);
  console.error(err);
  process.exit(1);
});
