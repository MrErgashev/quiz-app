#!/usr/bin/env node

/**
 * Test script to generate credentials locally without Supabase
 */

const crypto = require("crypto");
const path = require("path");
const { createDakStore } = require("./store");

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString("hex");
  return { hash, salt };
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I
  let pwd = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return pwd;
}

function generateLogin(groupName, num) {
  const padded = String(num).padStart(3, "0");
  return `${groupName}-${padded}`;
}

async function testGenerateCredentials() {
  console.log("=".repeat(60));
  console.log("  Test Credential Generation");
  console.log("=".repeat(60));
  console.log("");

  const dataDir = path.join(__dirname, "../../data");
  const store = createDakStore({ dataDir, supabase: null });

  // Read roster
  const roster = await store.getRoster();
  console.log("✅ Roster loaded");
  console.log(`   University: ${roster.university}`);
  console.log(`   Programs: ${roster.programs.length}`);
  console.log("");

  // Find IQTK-102 group
  const targetGroup = "IQTK-102";
  const targetDate = "2026-01-22";

  let targetGroupData = null;
  let targetProgram = null;

  for (const program of roster.programs || []) {
    for (const g of program.groups || []) {
      if (g.group_name === targetGroup && g.exam_date === targetDate) {
        targetGroupData = g;
        targetProgram = program;
        break;
      }
    }
    if (targetGroupData) break;
  }

  if (!targetGroupData) {
    console.error("❌ Group not found:", targetGroup);
    return;
  }

  console.log("✅ Found target group");
  console.log(`   Group: ${targetGroupData.group_name}`);
  console.log(`   Students: ${targetGroupData.students.length}`);
  console.log(`   Program: ${targetProgram.program_name}`);
  console.log("");

  // Generate credentials
  console.log("🔐 Generating credentials...");
  const accounts = await store.getAccounts();
  const credentials = [];

  for (let i = 0; i < targetGroupData.students.length; i++) {
    const fullName = targetGroupData.students[i];
    const login = generateLogin(targetGroup, i + 1);
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
      group: targetGroup,
      exam_date: targetDate,
      active: true,
      createdAt: new Date().toISOString(),
    };

    // Check if exists
    const existingIdx = accounts.findIndex((a) => a.login === login);
    if (existingIdx >= 0) {
      accounts[existingIdx] = newAccount;
    } else {
      accounts.push(newAccount);
    }

    credentials.push({
      login,
      password,
      full_name: fullName,
    });
  }

  // Save accounts
  console.log("💾 Saving accounts to local file...");
  await store.setAccounts(accounts);
  console.log("✅ Accounts saved!");
  console.log("");

  // Display first 5 credentials
  console.log("📋 Generated credentials (first 5):");
  credentials.slice(0, 5).forEach((cred, idx) => {
    console.log(`   ${idx + 1}. ${cred.login} | ${cred.password} | ${cred.full_name}`);
  });
  console.log("");

  // Verify file was created
  const fs = require("fs");
  const accountsPath = path.join(dataDir, "dak_accounts.json");
  if (fs.existsSync(accountsPath)) {
    const savedAccounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
    console.log("✅ File created successfully!");
    console.log(`   Path: ${accountsPath}`);
    console.log(`   Accounts in file: ${savedAccounts.length}`);
  } else {
    console.log("❌ File was not created!");
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("✅ Test completed");
  console.log("=".repeat(60));

  // Display all credentials for easy copy
  console.log("");
  console.log("📝 All credentials:");
  console.log("Login\t\t\tPassword");
  console.log("-".repeat(40));
  credentials.forEach((cred) => {
    console.log(`${cred.login}\t\t${cred.password}`);
  });
}

testGenerateCredentials().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  console.error(err);
  process.exit(1);
});
