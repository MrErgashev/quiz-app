const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDakStore } = require("./store");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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
      bank_ids: Array.isArray(body.bank_ids) ? body.bank_ids : config.bank_ids,
    };

    const normalized = {
      ...config,
      ...next,
      duration_minutes: parseInt(next.duration_minutes, 10),
      total_questions: parseInt(next.total_questions, 10),
      points_per_question: parseInt(next.points_per_question, 10),
      questions_per_bank: parseInt(next.questions_per_bank, 10),
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
      bank_ids: uniqueBankIds,
    });
    res.json(saved);
  });

  // =========================
  // Attempt (public)
  // =========================
  router.post("/public/dak/start", async (req, res) => {
    const { enabled } = await store.getExamMode();
    if (!enabled) return res.status(409).json({ error: "Exam mode is OFF" });

    const program_id = (req.body?.program_id || "").toString().trim();
    const group_name = (req.body?.group_name || "").toString().trim();
    const student_fullname = (req.body?.student_fullname || "").toString().trim();
    if (!program_id || !group_name || !student_fullname) {
      return res.status(400).json({ error: "program_id, group_name, student_fullname required" });
    }

    const roster = await store.getRoster();
    const program = (roster.programs || []).find((p) => p.program_id === program_id);
    if (!program) return res.status(400).json({ error: "Program topilmadi" });
    const group = (program.groups || []).find((g) => g.group_name === group_name);
    if (!group) return res.status(400).json({ error: "Guruh topilmadi" });
    const studentOk = (group.students || []).includes(student_fullname);
    if (!studentOk) return res.status(400).json({ error: "Talaba topilmadi" });

    const config = await store.getDakConfig();
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

  // Expose for server.js: parse helper used in export (optional)
  router._dak = { parseDakTestId };

  return router;
}

module.exports = createDakRouter;

