const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDakStore } = require("./store");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// =========================
// Password hashing utilities (using Node built-in crypto)
// =========================
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
  // Timing-safe comparison
  return crypto.timingSafeEqual(hash, storedHashBuffer);
}

// Generate random password: 8 chars, A-Z and 2-9 (no 0,O,1,I)
function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I
  let pwd = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    pwd += chars[bytes[i] % chars.length];
  }
  return pwd;
}

// Generate login from group + number: e.g., "TURK-101-001"
function generateLogin(groupName, num) {
  const padded = String(num).padStart(3, "0");
  return `${groupName}-${padded}`;
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function normalizeTeacherEmail(email) {
  return (email || "").toString().trim().toLowerCase();
}

function parseBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = (v || "").toString().trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return null;
}

function pickRandomSample(list, count) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const n = Math.max(0, Math.min(count, arr.length));
  // Fisher–Yates partial shuffle
  for (let i = arr.length - 1; i > arr.length - 1 - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(arr.length - n);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeChosenOption(chosen) {
  if (typeof chosen === "number" && Number.isFinite(chosen)) return chosen;
  const s = (chosen || "").toString().trim().toUpperCase();
  if (s === "A") return 0;
  if (s === "B") return 1;
  if (s === "C") return 2;
  if (s === "D") return 3;
  const n = parseInt(s, 10);
  if (Number.isFinite(n)) return n;
  return null;
}

function parseDakTestId(testId) {
  const m = /^DAK_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(testId || "");
  if (!m) return null;
  return { exam_date: m[1], program_id: m[2] };
}

function createDakRouter({ dataDir, supabase, upload, parser, resultsDir }) {
  const router = express.Router();
  const store = createDakStore({ dataDir, supabase });

  const teacherEmail = normalizeTeacherEmail(
    process.env.TEACHER_EMAIL || "ergashevmuhammadsodiq1995@gmail.com"
  );

  function requireTeacher(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const email = normalizeTeacherEmail(req.user?.emails?.[0]?.value || req.user?.email || "");
    if (!email || email !== teacherEmail) return res.status(403).json({ error: "Forbidden" });
    return next();
  }

  const DAK_SESSION_COOKIE = "dak_session";
  const SESSION_EXPIRE_MS = 6 * 60 * 60 * 1000; // 6 hours

  // =========================
  // Student Auth (login/password)
  // =========================
  router.post("/public/dak/auth/login", async (req, res) => {
    const login = (req.body?.login || "").toString().trim();
    const password = (req.body?.password || "").toString();

    if (!login || !password) {
      return res.status(400).json({ error: "Login va parol kiritilishi shart" });
    }

    const account = await store.getAccountByLogin(login);
    if (!account) {
      return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
    }

    // Verify password
    let valid = false;
    try {
      valid = verifyPassword(password, account.password_hash, account.salt);
    } catch {
      valid = false;
    }

    if (!valid) {
      return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
    }

    // Create session
    const session = await store.createSession(account.id, SESSION_EXPIRE_MS);

    // Set httpOnly cookie
    res.cookie(DAK_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_EXPIRE_MS,
      path: "/",
    });

    res.json({
      ok: true,
      meta: {
        university: account.university || "Oriental Universiteti",
        program: account.program,
        program_id: account.program_id,
        group: account.group,
        full_name: account.full_name,
        exam_date: account.exam_date,
      },
    });
  });

  router.get("/public/dak/auth/me", async (req, res) => {
    const token = req.cookies?.[DAK_SESSION_COOKIE];
    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const session = await store.getSessionByToken(token);
    if (!session) {
      res.clearCookie(DAK_SESSION_COOKIE, { path: "/" });
      return res.status(401).json({ error: "Session expired" });
    }

    const account = await store.getAccountById(session.accountId);
    if (!account || account.active === false) {
      res.clearCookie(DAK_SESSION_COOKIE, { path: "/" });
      return res.status(401).json({ error: "Account not found" });
    }

    res.json({
      ok: true,
      meta: {
        university: account.university || "Oriental Universiteti",
        program: account.program,
        program_id: account.program_id,
        group: account.group,
        full_name: account.full_name,
        exam_date: account.exam_date,
      },
    });
  });

  router.post("/public/dak/auth/logout", async (req, res) => {
    const token = req.cookies?.[DAK_SESSION_COOKIE];
    if (token) {
      await store.deleteSession(token);
    }
    res.clearCookie(DAK_SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // =========================
  // Exam mode flag
  // =========================
  router.get("/public/exam-mode", async (req, res) => {
    const { enabled } = await store.getExamMode();
    res.json({ enabled: !!enabled });
  });

  router.post("/teacher/exam-mode", requireTeacher, async (req, res) => {
    const enabled = parseBoolean(req.body?.enabled);
    if (enabled === null) return res.status(400).json({ error: "enabled must be boolean" });
    const saved = await store.setExamMode(enabled);
    res.json({ enabled: !!saved.enabled });
  });

  // =========================
  // Public config (faqat max_attempts)
  // =========================
  router.get("/public/dak/config", async (req, res) => {
    const config = await store.getDakConfig();
    // Faqat talaba uchun kerakli ma'lumotlarni qaytarish
    res.json({
      max_attempts_per_student: config.max_attempts_per_student || 1
    });
  });

  // =========================
  // Roster (public)
  // =========================
  router.get("/public/dak/programs", async (req, res) => {
    const roster = await store.getRoster();
    const programs = (roster.programs || []).map((p) => ({
      program_id: p.program_id,
      program_name: p.program_name,
    }));
    res.json(programs);
  });

  router.get("/public/dak/groups", async (req, res) => {
    const programId = (req.query?.program_id || "").toString();
    const roster = await store.getRoster();
    const program = (roster.programs || []).find((p) => p.program_id === programId);
    if (!program) return res.json([]);
    const groups = (program.groups || []).map((g) => ({
      group_name: g.group_name,
      exam_date: g.exam_date,
    }));
    res.json(groups);
  });

  router.get("/public/dak/students", async (req, res) => {
    const programId = (req.query?.program_id || "").toString();
    const groupName = (req.query?.group_name || "").toString();
    const roster = await store.getRoster();
    const program = (roster.programs || []).find((p) => p.program_id === programId);
    if (!program) return res.json([]);
    const group = (program.groups || []).find((g) => g.group_name === groupName);
    if (!group) return res.json([]);
    const students = (group.students || []).map((s) => ({
      fullname: s,
      exam_date: group.exam_date,
    }));
    res.json(students);
  });

  // =========================
  // Roster (teacher)
  // =========================
  router.get("/teacher/dak/roster", requireTeacher, async (req, res) => {
    const roster = await store.getRoster();
    res.json(roster);
  });

  router.post("/teacher/dak/roster", requireTeacher, async (req, res) => {
    const roster = req.body;
    if (!roster || typeof roster !== "object") return res.status(400).json({ error: "Invalid roster" });
    if (!Array.isArray(roster.programs)) return res.status(400).json({ error: "roster.programs must be array" });
    await store.setRoster(roster);
    res.json({ ok: true });
  });

  // =========================
  // Roster Import (Paste) - NEW
  // =========================

  // Helper: normalize program name for matching
  function normalizeProgramName(name) {
    return (name || "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[''`]/g, "'") // normalize apostrophes
      .replace(/\s+/g, " "); // collapse multiple spaces
  }

  // Helper: detect program_id from program_name
  function detectProgramId(programName) {
    const norm = normalizeProgramName(programName);

    // Known mappings
    if (norm.includes("iqtisod")) return "iqt";
    if (norm.includes("turizm")) return "tur";

    // Fallback: slugify (simple version)
    // Extract latin letters/numbers, join with underscore
    const slug = programName
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    return slug || "prog_" + crypto.randomBytes(4).toString("hex");
  }

  // Helper: convert date from dd.mm.yyyy or yyyy-mm-dd to yyyy-mm-dd
  function parseExamDate(dateStr) {
    const s = (dateStr || "").toString().trim();

    // Already yyyy-mm-dd format
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return s;
    }

    // dd.mm.yyyy format
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (match) {
      const day = match[1];
      const month = match[2];
      const year = match[3];
      return `${year}-${month}-${day}`;
    }

    return null; // invalid format
  }

  // Helper: parse raw text into structured rows
  function parseRosterText(rawText) {
    const lines = (rawText || "").toString().split(/\r?\n/);
    const rows = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i].trim();

      // Skip empty lines
      if (!line) continue;

      // Try TAB delimiter first
      let parts = line.split("\t").map(p => p.trim());

      // If not enough parts, try 2+ spaces
      if (parts.length < 4) {
        parts = line.split(/\s{2,}/).map(p => p.trim());
      }

      // Must have exactly 4 columns
      if (parts.length !== 4) {
        throw {
          line: lineNum,
          text: line,
          error: `Qator ${lineNum}: 4 ta ustun bo'lishi kerak (Yo'nalish, Guruh, Sana, F.I.Sh), lekin ${parts.length} ta topildi`
        };
      }

      const [program_name, group_name, exam_date_raw, full_name] = parts;

      if (!program_name || !group_name || !exam_date_raw || !full_name) {
        throw {
          line: lineNum,
          text: line,
          error: `Qator ${lineNum}: Barcha ustunlar to'ldirilishi shart`
        };
      }

      const exam_date = parseExamDate(exam_date_raw);
      if (!exam_date) {
        throw {
          line: lineNum,
          text: line,
          error: `Qator ${lineNum}: Sana formati noto'g'ri (dd.mm.yyyy yoki yyyy-mm-dd bo'lishi kerak): "${exam_date_raw}"`
        };
      }

      rows.push({
        line: lineNum,
        program_name: program_name.trim(),
        group_name: group_name.trim(),
        exam_date,
        full_name: full_name.trim()
      });
    }

    return rows;
  }

  // Helper: build roster JSON from parsed rows
  function buildRosterFromRows(rows, universityName = "Oriental Universiteti") {
    // Group by program_id
    const programsMap = new Map();

    for (const row of rows) {
      const program_id = detectProgramId(row.program_name);

      if (!programsMap.has(program_id)) {
        programsMap.set(program_id, {
          program_id,
          program_name: row.program_name, // Use first occurrence
          groupsMap: new Map()
        });
      }

      const prog = programsMap.get(program_id);

      // Check if program_name is consistent
      if (normalizeProgramName(prog.program_name) !== normalizeProgramName(row.program_name)) {
        // Different spelling for same program_id - use first one but warn in comment
      }

      const groupKey = row.group_name;

      if (!prog.groupsMap.has(groupKey)) {
        prog.groupsMap.set(groupKey, {
          group_name: row.group_name,
          exam_date: row.exam_date,
          students: []
        });
      }

      const grp = prog.groupsMap.get(groupKey);

      // Validate exam_date consistency
      if (grp.exam_date !== row.exam_date) {
        throw {
          line: row.line,
          error: `Qator ${row.line}: Guruh "${row.group_name}" uchun sana ziddiyati: avval "${grp.exam_date}", endi "${row.exam_date}"`
        };
      }

      // Add student (check duplicates)
      if (!grp.students.includes(row.full_name)) {
        grp.students.push(row.full_name);
      }
    }

    // Convert maps to arrays
    const programs = [];
    for (const [program_id, prog] of programsMap) {
      const groups = Array.from(prog.groupsMap.values());
      programs.push({
        program_id: prog.program_id,
        program_name: prog.program_name,
        groups
      });
    }

    return {
      university: universityName,
      programs
    };
  }

  // Endpoint: POST /api/teacher/dak/roster/import-paste
  router.post("/teacher/dak/roster/import-paste", requireTeacher, async (req, res) => {
    const rawText = (req.body?.raw_text || "").toString();
    const dryRun = req.query?.dry_run === "1" || req.query?.dry_run === "true";

    if (!rawText.trim()) {
      return res.status(400).json({ error: "raw_text bo'sh bo'lmasligi kerak" });
    }

    try {
      // Parse text
      const rows = parseRosterText(rawText);

      if (rows.length === 0) {
        return res.status(400).json({ error: "Hech qanday satr topilmadi" });
      }

      // Get current roster to preserve university name
      const currentRoster = await store.getRoster();
      const universityName = currentRoster?.university || "Oriental Universiteti";

      // Build roster JSON
      const roster = buildRosterFromRows(rows, universityName);

      // Calculate stats
      const stats = {
        programs: roster.programs.length,
        groups: roster.programs.reduce((sum, p) => sum + (p.groups || []).length, 0),
        students: roster.programs.reduce((sum, p) =>
          sum + (p.groups || []).reduce((s, g) => s + (g.students || []).length, 0), 0)
      };

      // If dry_run, just return preview
      if (dryRun) {
        return res.json({
          ok: true,
          dry_run: true,
          stats,
          roster
        });
      }

      // Save to file
      await store.setRoster(roster);

      res.json({
        ok: true,
        stats,
        message: "Roster muvaffaqiyatli saqlandi"
      });

    } catch (err) {
      // Handle parsing errors
      if (err && typeof err === "object" && err.line) {
        return res.status(400).json({
          error: err.error || "Parsing xatosi",
          line: err.line,
          text: err.text
        });
      }

      // Generic error
      console.error("Import-paste error:", err);
      return res.status(500).json({
        error: err?.message || "Serverda xatolik yuz berdi"
      });
    }
  });

  // =========================
  // Banks (teacher)
  // =========================
  router.post(
    "/teacher/dak/upload-bank",
    requireTeacher,
    upload.single("file"),
    async (req, res) => {
      const subject_name = (req.body?.subject_name || "").toString().trim();
      const file = req.file;
      if (!subject_name) return res.status(400).json({ error: "subject_name required" });
      if (!file?.path) return res.status(400).json({ error: "file required" });

      try {
        const text = fs.readFileSync(file.path, "utf-8");
        const questions = parser.parseQuestions(text);
        if (!Array.isArray(questions) || questions.length === 0) {
          return res.status(400).json({ error: "Savollar topilmadi" });
        }

        const config = await store.getDakConfig();
        const minCount = Math.max(1, config.questions_per_bank || 10);
        if (questions.length < minCount) {
          return res
            .status(400)
            .json({ error: `Bankda kamida ${minCount} ta savol bo'lishi kerak` });
        }

        const banks = await store.getBanks();
        const bank_id =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : crypto.randomBytes(12).toString("hex");
        const bank = {
          bank_id,
          subject_name,
          questions,
          created_at: new Date().toISOString(),
        };
        banks.push(bank);
        await store.setBanks(banks);

        return res.json({
          ok: true,
          bank_id,
          questions_count: questions.length,
        });
      } finally {
        safeUnlink(file.path);
      }
    }
  );

  router.get("/teacher/dak/banks", requireTeacher, async (req, res) => {
    const banks = await store.getBanks();
    res.json(
      banks.map((b) => ({
        bank_id: b.bank_id,
        subject_name: b.subject_name,
        questions_count: Array.isArray(b.questions) ? b.questions.length : 0,
        created_at: b.created_at,
      }))
    );
  });

  router.delete("/teacher/dak/banks/:bank_id", requireTeacher, async (req, res) => {
    const bankId = (req.params.bank_id || "").toString();
    const banks = await store.getBanks();
    const next = banks.filter((b) => b.bank_id !== bankId);
    if (next.length === banks.length) return res.status(404).json({ error: "Bank not found" });
    await store.setBanks(next);

    // configdan ham olib tashlaymiz (agar tanlangan bo'lsa)
    const cfg = await store.getDakConfig();
    const filteredBankIds = (cfg.bank_ids || []).filter((id) => id !== bankId);
    if (filteredBankIds.length !== (cfg.bank_ids || []).length) {
      await store.setDakConfig({ ...cfg, bank_ids: filteredBankIds });
    }

    res.json({ ok: true });
  });

  // =========================
  // Config (teacher)
  // =========================
  router.get("/teacher/dak/config", requireTeacher, async (req, res) => {
    const config = await store.getDakConfig();
    res.json(config);
  });

  router.post("/teacher/dak/config", requireTeacher, async (req, res) => {
    const body = req.body || {};
    const config = await store.getDakConfig();

    const next = {
      duration_minutes: body.duration_minutes ?? config.duration_minutes,
      total_questions: body.total_questions ?? config.total_questions,
      points_per_question: body.points_per_question ?? config.points_per_question,
      questions_per_bank: body.questions_per_bank ?? config.questions_per_bank,
      max_attempts_per_student: body.max_attempts_per_student ?? config.max_attempts_per_student,
      bank_ids: Array.isArray(body.bank_ids) ? body.bank_ids : config.bank_ids,
    };

    const normalized = {
      ...config,
      ...next,
      duration_minutes: parseInt(next.duration_minutes, 10),
      total_questions: parseInt(next.total_questions, 10),
      points_per_question: parseInt(next.points_per_question, 10),
      questions_per_bank: parseInt(next.questions_per_bank, 10),
      max_attempts_per_student: parseInt(next.max_attempts_per_student, 10),
      bank_ids: (Array.isArray(next.bank_ids) ? next.bank_ids : [])
        .map((x) => (x || "").toString().trim())
        .filter(Boolean),
    };

    if (!Number.isFinite(normalized.duration_minutes) || normalized.duration_minutes <= 0) {
      return res.status(400).json({ error: "duration_minutes must be > 0" });
    }
    if (!Number.isFinite(normalized.total_questions) || normalized.total_questions <= 0) {
      return res.status(400).json({ error: "total_questions must be > 0" });
    }
    if (!Number.isFinite(normalized.points_per_question) || normalized.points_per_question <= 0) {
      return res.status(400).json({ error: "points_per_question must be > 0" });
    }
    if (!Number.isFinite(normalized.questions_per_bank) || normalized.questions_per_bank <= 0) {
      return res.status(400).json({ error: "questions_per_bank must be > 0" });
    }
    if (
      !Number.isFinite(normalized.max_attempts_per_student) ||
      normalized.max_attempts_per_student <= 0 ||
      normalized.max_attempts_per_student > 10
    ) {
      return res.status(400).json({ error: "max_attempts_per_student must be 1..10" });
    }

    const uniqueBankIds = Array.from(new Set(normalized.bank_ids));
    if (uniqueBankIds.length !== normalized.bank_ids.length) {
      return res.status(400).json({ error: "bank_ids must be unique" });
    }

    if (uniqueBankIds.length * normalized.questions_per_bank !== normalized.total_questions) {
      return res.status(400).json({
        error: "bank_ids.length * questions_per_bank must equal total_questions",
      });
    }

    const banks = await store.getBanks();
    const byId = new Map(banks.map((b) => [b.bank_id, b]));
    for (const id of uniqueBankIds) {
      const bank = byId.get(id);
      if (!bank) return res.status(400).json({ error: `Bank not found: ${id}` });
      const count = Array.isArray(bank.questions) ? bank.questions.length : 0;
      if (count < normalized.questions_per_bank) {
        return res.status(400).json({
          error: `Bank ${id} savollari yetarli emas (min: ${normalized.questions_per_bank})`,
        });
      }
    }

    const saved = await store.setDakConfig({
      duration_minutes: normalized.duration_minutes,
      total_questions: normalized.total_questions,
      points_per_question: normalized.points_per_question,
      questions_per_bank: normalized.questions_per_bank,
      max_attempts_per_student: normalized.max_attempts_per_student,
      bank_ids: uniqueBankIds,
    });
    res.json(saved);
  });

  // =========================
  // Attempt (public) - Auth-based start
  // =========================
  router.post("/public/dak/start", async (req, res) => {
    const { enabled } = await store.getExamMode();
    if (!enabled) return res.status(409).json({ error: "Exam mode is OFF" });

    // Check session cookie for authenticated student
    const token = req.cookies?.[DAK_SESSION_COOKIE];
    if (!token) {
      return res.status(401).json({ error: "Avval tizimga kiring (login)" });
    }

    const session = await store.getSessionByToken(token);
    if (!session) {
      res.clearCookie(DAK_SESSION_COOKIE, { path: "/" });
      return res.status(401).json({ error: "Sessiya muddati tugagan. Qaytadan kiring." });
    }

    const account = await store.getAccountById(session.accountId);
    if (!account || account.active === false) {
      res.clearCookie(DAK_SESSION_COOKIE, { path: "/" });
      return res.status(401).json({ error: "Hisob topilmadi" });
    }

    // Use account data instead of request body
    const program_id = account.program_id;
    const group_name = account.group;
    const student_fullname = account.full_name;
    const exam_date = account.exam_date;

    // Validate against roster (still necessary for security)
    const roster = await store.getRoster();
    const program = (roster.programs || []).find((p) => p.program_id === program_id);
    if (!program) return res.status(400).json({ error: "Program topilmadi" });
    const group = (program.groups || []).find((g) => g.group_name === group_name);
    if (!group) return res.status(400).json({ error: "Guruh topilmadi" });
    const studentOk = (group.students || []).includes(student_fullname);
    if (!studentOk) return res.status(400).json({ error: "Talaba topilmadi" });

    const config = await store.getDakConfig();

    // Urinishlar sonini tekshirish
    const maxAttempts = config.max_attempts_per_student || 1;
    const existingAttempts = await store.countStudentAttempts(program_id, group_name, student_fullname, exam_date);
    if (existingAttempts >= maxAttempts) {
      return res.status(403).json({
        error: `Sizning urinishlar sonigiz tugadi (${existingAttempts}/${maxAttempts}). Qayta topshirish imkoniyati yo'q.`
      });
    }
    const bankIds = Array.isArray(config.bank_ids) ? config.bank_ids : [];
    if (!bankIds.length) return res.status(400).json({ error: "DAK config bank_ids bo'sh" });

    if (bankIds.length * config.questions_per_bank !== config.total_questions) {
      return res.status(400).json({ error: "DAK config noto'g'ri (count mismatch)" });
    }

    const banks = await store.getBanks();
    const byId = new Map(banks.map((b) => [b.bank_id, b]));

    const selectedQuestions = [];
    for (const id of bankIds) {
      const bank = byId.get(id);
      if (!bank) return res.status(400).json({ error: `Bank topilmadi: ${id}` });
      const pool = Array.isArray(bank.questions) ? bank.questions : [];
      if (pool.length < config.questions_per_bank) {
        return res.status(400).json({ error: `Bankda savol yetarli emas: ${id}` });
      }
      const picked = pickRandomSample(pool, config.questions_per_bank);
      // Bankdagi savollarni mutatsiya qilmaslik uchun clone qilamiz (har attempt muhrlangan bo'lsin).
      const cloned = picked.map((q) => {
        const options = Array.isArray(q?.options) ? q.options : [];
        const clonedOptions = options.map((o) => ({
          text: o?.text ?? "",
          isCorrect: !!o?.isCorrect,
        }));
        shuffleInPlace(clonedOptions); // javob variantlari ham shuffle bo'lsin
        return { ...(q && typeof q === "object" ? q : {}), options: clonedOptions };
      });
      selectedQuestions.push(...cloned);
    }

    shuffleInPlace(selectedQuestions);

    const startedAt = new Date().toISOString();
    const attempt = await store.createAttempt({
      university: roster.university || "Oriental Universiteti",
      program_id,
      program_name: program.program_name,
      group_name,
      student_fullname,
      exam_date: group.exam_date,
      started_at: startedAt,
      finished_at: null,
      duration_minutes: config.duration_minutes,
      total_questions: config.total_questions,
      points_per_question: config.points_per_question,
      questions: selectedQuestions,
      answers: {},
    });

    res.json({ attempt_id: attempt.attempt_id });
  });

  router.get("/public/dak/attempt/:attempt_id/questions", async (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const attemptId = req.params.attempt_id;
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) return res.status(404).json({ error: "Attempt topilmadi" });

    const questions = (attempt.questions || []).map((q, idx) => ({
      index: idx,
      question: q.question,
      options: (q.options || []).map((o) => ({ text: o.text })),
    }));

    res.json({
      attempt_id: attempt.attempt_id,
      university: attempt.university,
      program_name: attempt.program_name,
      group_name: attempt.group_name,
      student_fullname: attempt.student_fullname,
      exam_date: attempt.exam_date,
      started_at: attempt.started_at,
      duration_minutes: attempt.duration_minutes,
      total_questions: attempt.total_questions,
      answers: attempt.answers || {},
      questions,
    });
  });

  router.post("/public/dak/attempt/:attempt_id/answer", async (req, res) => {
    const attemptId = req.params.attempt_id;
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) return res.status(404).json({ error: "Attempt topilmadi" });
    if (attempt.finished_at) return res.status(409).json({ error: "Attempt finished" });

    const questionIndex = parseInt(req.body?.question_index, 10);
    if (!Number.isFinite(questionIndex) || questionIndex < 0) {
      return res.status(400).json({ error: "question_index invalid" });
    }
    const chosenOption = normalizeChosenOption(req.body?.chosen_option);
    if (chosenOption === null) return res.status(400).json({ error: "chosen_option invalid" });

    const q = (attempt.questions || [])[questionIndex];
    const optLen = Array.isArray(q?.options) ? q.options.length : 0;
    if (questionIndex >= (attempt.questions || []).length) {
      return res.status(400).json({ error: "question_index out of range" });
    }
    if (chosenOption < 0 || chosenOption >= optLen) {
      return res.status(400).json({ error: "chosen_option out of range" });
    }

    attempt.answers = attempt.answers || {};
    attempt.answers[String(questionIndex)] = chosenOption;
    attempt.updated_at = new Date().toISOString();
    await store.saveAttempt(attemptId, attempt);
    res.json({ ok: true });
  });

  async function saveResultRow(result) {
    ensureDir(resultsDir);
    if (supabase) {
      const { error } = await supabase.from("results").insert({
        test_id: result.testId,
        fullname: result.fullname,
        group: result.group,
        university: result.university,
        faculty: result.faculty,
        correct: result.correct,
        total: result.total,
        score: result.score,
        started_at: result.startedAt ? new Date(result.startedAt).toISOString() : null,
        finished_at: result.finishedAt ? new Date(result.finishedAt).toISOString() : null,
        time_spent_seconds: result.timeSpent ?? null,
      });
      if (error) throw error;
      return;
    }

    const fileName = `result_${result.testId}_${Date.now()}.json`;
    const savePath = path.join(resultsDir, fileName);
    fs.writeFileSync(savePath, JSON.stringify(result, null, 2), "utf-8");
  }

  router.post("/public/dak/attempt/:attempt_id/finish", async (req, res) => {
    const attemptId = req.params.attempt_id;
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) return res.status(404).json({ error: "Attempt topilmadi" });

    if (attempt.finished_at) {
      return res.json({
        score_points: attempt.score_points ?? 0,
        correct_count: attempt.correct_count ?? 0,
        total_questions: attempt.total_questions ?? 0,
      });
    }

    const totalQuestions = Array.isArray(attempt.questions) ? attempt.questions.length : 0;
    const pointsPer = parseInt(attempt.points_per_question, 10) || 2;
    const answers = attempt.answers || {};

    let correctCount = 0;
    for (let i = 0; i < totalQuestions; i++) {
      const q = attempt.questions[i];
      const opts = Array.isArray(q?.options) ? q.options : [];
      const correctIdx = opts.findIndex((o) => o && o.isCorrect);
      const chosen = answers[String(i)];
      if (correctIdx >= 0 && chosen === correctIdx) correctCount++;
    }

    const scorePoints = Math.max(0, correctCount * pointsPer);
    const finishedAt = new Date().toISOString();
    const startedAt = attempt.started_at ? new Date(attempt.started_at).getTime() : null;
    const timeSpent =
      startedAt && Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : null;

    attempt.correct_count = correctCount;
    attempt.score_points = scorePoints;
    attempt.finished_at = finishedAt;
    await store.saveAttempt(attemptId, attempt);

    const testId = `DAK_${attempt.exam_date}_${attempt.program_id}`;
    const resultRow = {
      testId,
      fullname: attempt.student_fullname,
      group: attempt.group_name,
      university: attempt.university || "Oriental Universiteti",
      faculty: attempt.program_name,
      correct: correctCount,
      total: totalQuestions,
      score: scorePoints,
      startedAt: attempt.started_at,
      finishedAt,
      timeSpent,
    };

    try {
      await saveResultRow(resultRow);
    } catch (e) {
      console.error("DAK save result error:", e?.message || e);
      // Attempt saqlangan bo'ladi, lekin natija tizimiga yozilmagan bo'lishi mumkin.
      // Clientga baribir ballni qaytaramiz.
    }

    res.json({
      score_points: scorePoints,
      correct_count: correctCount,
      total_questions: totalQuestions,
    });
  });

  // Teacher helper: roster'dan export id'larni chiqarish (ixtiyoriy)
  router.get("/teacher/dak/exports", requireTeacher, async (req, res) => {
    const roster = await store.getRoster();
    const exports = [];
    for (const p of roster.programs || []) {
      const dates = new Set((p.groups || []).map((g) => g.exam_date).filter(Boolean));
      for (const exam_date of dates) {
        exports.push({
          test_id: `DAK_${exam_date}_${p.program_id}`,
          label: `DAK ${p.program_name} (${exam_date}) Export`,
        });
      }
    }
    res.json(exports);
  });

  // Public helper: attempt meta (optional)
  router.get("/public/dak/attempt/:attempt_id/status", async (req, res) => {
    const attemptId = req.params.attempt_id;
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) return res.status(404).json({ error: "Attempt topilmadi" });
    res.json({
      attempt_id: attempt.attempt_id,
      finished_at: attempt.finished_at,
      started_at: attempt.started_at,
    });
  });

  // =========================
  // Teacher: Credentials Generation
  // =========================

  // Generate credentials for students in a group
  router.post("/teacher/dak/credentials/generate", requireTeacher, async (req, res) => {
    const group = (req.body?.group || "").toString().trim();
    const exam_date = (req.body?.exam_date || "").toString().trim();
    const regenerate = !!req.body?.regenerate;

    if (!group || !exam_date) {
      return res.status(400).json({ error: "group va exam_date kiritilishi shart" });
    }

    // Find students from roster
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
      return res.status(404).json({ error: "Guruh topilmadi" });
    }

    const students = targetGroup.students || [];
    if (students.length === 0) {
      return res.status(400).json({ error: "Guruhda talabalar yo'q" });
    }

    const accounts = await store.getAccounts();
    const createdCredentials = [];

    for (let i = 0; i < students.length; i++) {
      const fullName = students[i];
      const login = generateLogin(group, i + 1);

      // Check if account already exists
      const existingIdx = accounts.findIndex(
        (a) => a.login === login || (a.group === group && a.full_name === fullName && a.exam_date === exam_date)
      );

      if (existingIdx >= 0 && !regenerate) {
        // Already exists, skip (don't expose password)
        createdCredentials.push({
          login: accounts[existingIdx].login,
          full_name: fullName,
          group,
          exam_date,
          password: null, // Not shown for existing accounts
          existing: true,
        });
        continue;
      }

      // Generate new password
      const password = generatePassword();
      const { hash, salt } = hashPassword(password);

      const accountId =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : crypto.randomBytes(16).toString("hex");

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
        created_at: new Date().toISOString(),
      };

      if (existingIdx >= 0) {
        // Replace existing
        accounts[existingIdx] = newAccount;
      } else {
        accounts.push(newAccount);
      }

      createdCredentials.push({
        login,
        full_name: fullName,
        group,
        exam_date,
        password, // Only shown when creating/regenerating
        existing: false,
      });
    }

    await store.setAccounts(accounts);

    res.json({
      ok: true,
      credentials: createdCredentials,
      total: createdCredentials.length,
      new_count: createdCredentials.filter((c) => !c.existing).length,
    });
  });

  // List credentials (without passwords)
  router.get("/teacher/dak/credentials/list", requireTeacher, async (req, res) => {
    const group = (req.query?.group || "").toString().trim();
    const exam_date = (req.query?.exam_date || "").toString().trim();

    const accounts = await store.getAccounts();
    let filtered = accounts;

    if (group) {
      filtered = filtered.filter((a) => a.group === group);
    }
    if (exam_date) {
      filtered = filtered.filter((a) => a.exam_date === exam_date);
    }

    const list = filtered.map((a) => ({
      login: a.login,
      full_name: a.full_name,
      group: a.group,
      exam_date: a.exam_date,
      program: a.program,
      active: a.active !== false,
      createdAt: a.createdAt,
    }));

    res.json(list);
  });

  // Get available groups for credential generation
  router.get("/teacher/dak/credentials/groups", requireTeacher, async (req, res) => {
    const roster = await store.getRoster();
    const groups = [];

    for (const program of roster.programs || []) {
      for (const g of program.groups || []) {
        groups.push({
          group_name: g.group_name,
          exam_date: g.exam_date,
          program_name: program.program_name,
          student_count: (g.students || []).length,
        });
      }
    }

    res.json(groups);
  });

  // Expose for server.js: parse helper used in export (optional)
  router._dak = { parseDakTestId };

  return router;
}

module.exports = createDakRouter;

