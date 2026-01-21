const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");

  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    fs.renameSync(tmpPath, filePath);
  }
}

function normalizeString(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(normalizeString).filter(Boolean);
}

async function getSettingFromSupabase(supabase, key) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .single();
    if (error) return null;
    return data?.value ?? null;
  } catch {
    return null;
  }
}

async function setSettingToSupabase(supabase, key, value) {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key, value }, { onConflict: "key" });
    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeExamMode(value) {
  const enabled = !!value?.enabled;
  return { enabled };
}

function normalizeDakConfig(value) {
  const duration_minutes = Number.isFinite(+value?.duration_minutes)
    ? Math.max(1, parseInt(value.duration_minutes, 10))
    : 80;
  const total_questions = Number.isFinite(+value?.total_questions)
    ? Math.max(1, parseInt(value.total_questions, 10))
    : 50;
  const points_per_question = Number.isFinite(+value?.points_per_question)
    ? Math.max(1, parseInt(value.points_per_question, 10))
    : 2;
  const questions_per_bank = Number.isFinite(+value?.questions_per_bank)
    ? Math.max(1, parseInt(value.questions_per_bank, 10))
    : 10;
  const max_attempts_per_student = Number.isFinite(+value?.max_attempts_per_student)
    ? Math.max(1, parseInt(value.max_attempts_per_student, 10))
    : 1;
  const bank_ids = normalizeStringArray(value?.bank_ids);

  return {
    duration_minutes,
    total_questions,
    points_per_question,
    bank_ids,
    questions_per_bank,
    max_attempts_per_student,
  };
}

function createDakStore({ dataDir, supabase }) {
  const settingsPath = path.join(dataDir, "app_settings.json");
  const rosterPath = path.join(dataDir, "dak_roster.json");
  const banksPath = path.join(dataDir, "dak_banks.json");
  const configPath = path.join(dataDir, "dak_config.json");
  const attemptsDir = path.join(dataDir, "dak_attempts");

  ensureDir(attemptsDir);

  async function getExamMode() {
    const fromDb = await getSettingFromSupabase(supabase, "exam_mode");
    if (fromDb && typeof fromDb === "object") return normalizeExamMode(fromDb);

    const file = safeReadJson(settingsPath, {});
    if (file?.exam_mode && typeof file.exam_mode === "object") {
      return normalizeExamMode(file.exam_mode);
    }

    const init = { ...(file || {}), exam_mode: { enabled: false } };
    atomicWriteJson(settingsPath, init);
    return { enabled: false };
  }

  async function setExamMode(enabled) {
    const value = { enabled: !!enabled };
    const ok = await setSettingToSupabase(supabase, "exam_mode", value);
    if (ok) return value;

    const file = safeReadJson(settingsPath, {});
    const next = { ...(file || {}), exam_mode: value };
    atomicWriteJson(settingsPath, next);
    return value;
  }

  async function getDakConfig() {
    const fromDb = await getSettingFromSupabase(supabase, "dak_config");
    if (fromDb && typeof fromDb === "object") return normalizeDakConfig(fromDb);

    const file = safeReadJson(configPath, null);
    if (file && typeof file === "object") return normalizeDakConfig(file);

    const init = normalizeDakConfig({});
    atomicWriteJson(configPath, init);
    return init;
  }

  async function setDakConfig(config) {
    const value = normalizeDakConfig(config);
    const ok = await setSettingToSupabase(supabase, "dak_config", value);
    if (ok) return value;

    atomicWriteJson(configPath, value);
    return value;
  }

  async function getRoster() {
    const fallback = { university: "Oriental Universiteti", programs: [] };
    const roster = safeReadJson(rosterPath, fallback);
    if (!roster || typeof roster !== "object") return fallback;
    if (!Array.isArray(roster.programs)) return { ...roster, programs: [] };
    if (!normalizeString(roster.university)) return { ...roster, university: fallback.university };
    return roster;
  }

  async function setRoster(roster) {
    atomicWriteJson(rosterPath, roster);
    return roster;
  }

  async function getBanks() {
    const banks = safeReadJson(banksPath, []);
    return Array.isArray(banks) ? banks : [];
  }

  async function setBanks(banks) {
    atomicWriteJson(banksPath, Array.isArray(banks) ? banks : []);
    return banks;
  }

  function getAttemptPath(attemptId) {
    const safeId = normalizeString(attemptId);
    return path.join(attemptsDir, `${safeId}.json`);
  }

  async function createAttempt(attempt) {
    const attempt_id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");
    const record = { ...attempt, attempt_id };
    atomicWriteJson(getAttemptPath(attempt_id), record);
    return record;
  }

  async function getAttempt(attemptId) {
    const p = getAttemptPath(attemptId);
    const obj = safeReadJson(p, null);
    return obj && typeof obj === "object" ? obj : null;
  }

  async function saveAttempt(attemptId, attempt) {
    atomicWriteJson(getAttemptPath(attemptId), attempt);
    return attempt;
  }

  async function countStudentAttempts(programId, groupName, studentFullname, examDate) {
    // Talabaning shu imtihon uchun nechta attempt yaratganini sanash
    ensureDir(attemptsDir);
    let count = 0;

    try {
      const files = fs.readdirSync(attemptsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const attempt = safeReadJson(path.join(attemptsDir, file), null);
          if (!attempt) continue;
          if (
            attempt.program_id === programId &&
            attempt.group_name === groupName &&
            attempt.student_fullname === studentFullname &&
            attempt.exam_date === examDate
          ) {
            count++;
          }
        } catch {}
      }
    } catch {}

    return count;
  }

  return {
    getExamMode,
    setExamMode,
    getDakConfig,
    setDakConfig,
    getRoster,
    setRoster,
    getBanks,
    setBanks,
    createAttempt,
    getAttempt,
    saveAttempt,
    countStudentAttempts,
  };
}

module.exports = { createDakStore };

