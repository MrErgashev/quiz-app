const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { cleanOptionPrefix } = require("../parser");

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
  const accountsPath = path.join(dataDir, "dak_accounts.json");
  const sessionsPath = path.join(dataDir, "dak_sessions.json");

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

    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_roster")
          .select("*")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows

        if (data && data.roster_data) {
          const roster = data.roster_data;
          if (!roster || typeof roster !== "object") return fallback;
          if (!Array.isArray(roster.programs)) return { ...roster, programs: [] };
          if (!normalizeString(roster.university)) return { ...roster, university: fallback.university };
          return roster;
        }
      } catch (err) {
        console.error("getRoster Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const roster = safeReadJson(rosterPath, fallback);
    if (!roster || typeof roster !== "object") return fallback;
    if (!Array.isArray(roster.programs)) return { ...roster, programs: [] };
    if (!normalizeString(roster.university)) return { ...roster, university: fallback.university };
    return roster;
  }

  async function setRoster(roster) {
    // Try Supabase first
    if (supabase) {
      try {
        // Delete old roster entries (keep only latest)
        await supabase.from("dak_roster").delete().neq("id", "00000000-0000-0000-0000-000000000000");

        // Insert new roster
        const { error } = await supabase.from("dak_roster").insert({
          roster_data: roster,
          updated_at: new Date().toISOString()
        });

        if (error) throw error;
        return roster;
      } catch (err) {
        console.error("setRoster Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    atomicWriteJson(rosterPath, roster);
    return roster;
  }

  async function getBanks() {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_banks")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;

        // Transform DB format to in-memory format
        return (data || []).map(row => ({
          bank_id: row.bank_id,
          subject_name: row.subject_name,
          questions: row.questions || [],
          created_at: row.created_at
        }));
      } catch (err) {
        console.error("getBanks Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const banks = safeReadJson(banksPath, []);
    return Array.isArray(banks) ? banks : [];
  }

  async function setBanks(banks) {
    // Try Supabase first
    if (supabase) {
      try {
        // Delete all existing banks
        await supabase.from("dak_banks").delete().neq("id", "00000000-0000-0000-0000-000000000000");

        // Insert new banks
        if (Array.isArray(banks) && banks.length > 0) {
          const rows = banks.map(b => ({
            bank_id: b.bank_id,
            subject_name: b.subject_name || "",
            questions: b.questions || [],
            created_at: b.created_at || new Date().toISOString()
          }));

          const { error } = await supabase.from("dak_banks").insert(rows);
          if (error) throw error;
        }

        return banks;
      } catch (err) {
        console.error("setBanks Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
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

    // Try Supabase first
    if (supabase) {
      try {
        const { error } = await supabase.from("dak_attempts").insert({
          attempt_id,
          university: record.university || "Oriental Universiteti",
          program_id: record.program_id,
          program_name: record.program_name,
          group_name: record.group_name,
          student_fullname: record.student_fullname,
          exam_date: record.exam_date,
          started_at: record.started_at,
          finished_at: record.finished_at || null,
          updated_at: new Date().toISOString(),
          duration_minutes: record.duration_minutes,
          total_questions: record.total_questions,
          points_per_question: record.points_per_question,
          questions: record.questions || [],
          answers: record.answers || {},
          correct_count: record.correct_count || null,
          score_points: record.score_points || null
        });

        if (error) throw error;
        return record;
      } catch (err) {
        console.error("createAttempt Supabase error:", err.message || err);

        // Agar "single active attempt" unique index ishlasa, parallel start holatida
        // mavjud unfinished attemptni qaytarib yuboramiz (fallback local yaratmaymiz).
        const pgCode = err?.code || err?.details?.code;
        if (pgCode === "23505") {
          try {
            const existing = await findActiveAttempt(
              record.program_id,
              record.group_name,
              record.student_fullname,
              record.exam_date
            );
            if (existing) return existing;
          } catch {}
        }
      }
    }

    // Fallback to local file
    atomicWriteJson(getAttemptPath(attempt_id), record);
    return record;
  }

  async function findActiveAttempt(programId, groupName, studentFullname, examDate) {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_attempts")
          .select("*")
          .eq("program_id", programId)
          .eq("group_name", groupName)
          .eq("student_fullname", studentFullname)
          .eq("exam_date", examDate)
          .is("finished_at", null)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error;
        return data || null;
      } catch (err) {
        console.error("findActiveAttempt Supabase error:", err.message || err);
      }
    }

    // Fallback to local files
    ensureDir(attemptsDir);
    try {
      const files = fs.readdirSync(attemptsDir).filter((f) => f.endsWith(".json"));
      let best = null;
      let bestTs = -1;
      for (const file of files) {
        try {
          const attempt = safeReadJson(path.join(attemptsDir, file), null);
          if (!attempt || typeof attempt !== "object") continue;
          if (
            attempt.program_id !== programId ||
            attempt.group_name !== groupName ||
            attempt.student_fullname !== studentFullname ||
            attempt.exam_date !== examDate
          ) {
            continue;
          }
          if (attempt.finished_at) continue;
          const ts = attempt.started_at ? new Date(attempt.started_at).getTime() : -1;
          if (Number.isFinite(ts) && ts > bestTs) {
            bestTs = ts;
            best = attempt;
          } else if (!best && !attempt.started_at) {
            best = attempt;
          }
        } catch {}
      }
      return best;
    } catch {
      return null;
    }
  }

  async function getAttempt(attemptId) {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_attempts")
          .select("*")
          .eq("attempt_id", attemptId)
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error;
        return data || null;
      } catch (err) {
        console.error("getAttempt Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const p = getAttemptPath(attemptId);
    const obj = safeReadJson(p, null);
    return obj && typeof obj === "object" ? obj : null;
  }

  async function finishAttempt(attemptId, patch) {
    const finishedAt = patch?.finished_at || new Date().toISOString();
    const update = {
      finished_at: finishedAt,
      updated_at: new Date().toISOString(),
      answers: patch?.answers || {},
      correct_count: Number.isFinite(+patch?.correct_count) ? +patch.correct_count : null,
      score_points: Number.isFinite(+patch?.score_points) ? +patch.score_points : null,
    };

    // Try Supabase first (best-effort atomic: only if unfinished)
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_attempts")
          .update(update)
          .eq("attempt_id", attemptId)
          .is("finished_at", null)
          .select("*")
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error;
        if (data) return { attempt: data, didFinish: true };

        const current = await getAttempt(attemptId);
        return { attempt: current, didFinish: false };
      } catch (err) {
        console.error("finishAttempt Supabase error:", err.message || err);
      }
    }

    // Fallback to local file (not truly atomic, but prevents double-finish in the common case)
    const current = await getAttempt(attemptId);
    if (!current) return { attempt: null, didFinish: false };
    if (current.finished_at) return { attempt: current, didFinish: false };

    const next = {
      ...current,
      ...patch,
      finished_at: finishedAt,
      updated_at: update.updated_at,
    };
    atomicWriteJson(getAttemptPath(attemptId), next);
    return { attempt: next, didFinish: true };
  }

  async function saveAttempt(attemptId, attempt) {
    // Try Supabase first
    if (supabase) {
      try {
        const { error } = await supabase
          .from("dak_attempts")
          .update({
            finished_at: attempt.finished_at || null,
            updated_at: new Date().toISOString(),
            answers: attempt.answers || {},
            correct_count: attempt.correct_count || null,
            score_points: attempt.score_points || null
          })
          .eq("attempt_id", attemptId);

        if (error) throw error;
        return attempt;
      } catch (err) {
        console.error("saveAttempt Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    atomicWriteJson(getAttemptPath(attemptId), attempt);
    return attempt;
  }

  async function countStudentAttempts(programId, groupName, studentFullname, examDate) {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_attempts")
          .select("attempt_id", { count: "exact", head: false })
          .eq("program_id", programId)
          .eq("group_name", groupName)
          .eq("student_fullname", studentFullname)
          .eq("exam_date", examDate)
          .not("finished_at", "is", null);

        if (error) throw error;
        return data ? data.length : 0;
      } catch (err) {
        console.error("countStudentAttempts Supabase error:", err.message || err);
      }
    }

    // Fallback to local files
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
            attempt.exam_date === examDate &&
            attempt.finished_at
          ) {
            count++;
          }
        } catch {}
      }
    } catch {}

    return count;
  }

  // =========================
  // Accounts (student login/password)
  // =========================
  async function getAccounts() {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_accounts")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;
        return data || [];
      } catch (err) {
        console.error("getAccounts Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const accounts = safeReadJson(accountsPath, []);
    return Array.isArray(accounts) ? accounts : [];
  }

  async function setAccounts(accounts) {
    // Try Supabase first
    if (supabase) {
      try {
        if (Array.isArray(accounts) && accounts.length > 0) {
          // Normalize field names for Supabase (createdAt -> created_at)
          const normalizedAccounts = accounts.map(acc => ({
            id: acc.id,
            login: acc.login,
            password_hash: acc.password_hash,
            salt: acc.salt,
            full_name: acc.full_name,
            university: acc.university,
            program: acc.program,
            program_id: acc.program_id,
            group: acc.group,
            exam_date: acc.exam_date,
            active: acc.active !== false,
            created_at: acc.created_at || acc.createdAt || new Date().toISOString(),
          }));

          // XAVFSIZ: upsert ishlatamiz (delete-insert o'rniga)
          // Agar login mavjud bo'lsa - yangilanadi, bo'lmasa - qo'shiladi
          for (const acc of normalizedAccounts) {
            const { error } = await supabase
              .from("dak_accounts")
              .upsert(acc, { onConflict: "login" });
            if (error) {
              console.error("setAccounts Supabase upsert error:", error.message, error.details, error.hint);
              throw error;
            }
          }
        }
        return accounts;
      } catch (err) {
        console.error("setAccounts Supabase error:", err.message || err);
        // Don't fallback silently - throw error so UI knows something went wrong
        throw err;
      }
    }

    // Fallback to local file
    atomicWriteJson(accountsPath, Array.isArray(accounts) ? accounts : []);
    return accounts;
  }

  async function getAccountByLogin(login) {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_accounts")
          .select("*")
          .eq("login", login)
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error;
        return data && data.active !== false ? data : null;
      } catch (err) {
        console.error("getAccountByLogin Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const accounts = await getAccounts();
    return accounts.find((a) => a.login === login && a.active !== false) || null;
  }

  async function getAccountById(id) {
    // Try Supabase first
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from("dak_accounts")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        if (error && error.code !== "PGRST116") throw error;
        return data || null;
      } catch (err) {
        console.error("getAccountById Supabase error:", err.message || err);
      }
    }

    // Fallback to local file
    const accounts = await getAccounts();
    return accounts.find((a) => a.id === id) || null;
  }

  // =========================
  // Sessions (httpOnly cookie based)
  // =========================
  async function getSessions() {
    const sessions = safeReadJson(sessionsPath, []);
    return Array.isArray(sessions) ? sessions : [];
  }

  async function setSessions(sessions) {
    atomicWriteJson(sessionsPath, Array.isArray(sessions) ? sessions : []);
    return sessions;
  }

  async function createSession(accountId, expiresInMs = 6 * 60 * 60 * 1000) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    const session = { token, accountId, expiresAt, createdAt: new Date().toISOString() };

    const sessions = await getSessions();
    sessions.push(session);
    await setSessions(sessions);

    return session;
  }

  async function getSessionByToken(token) {
    if (!token) return null;
    const sessions = await getSessions();
    const session = sessions.find((s) => s.token === token);
    if (!session) return null;

    // Check expiration
    if (new Date(session.expiresAt) < new Date()) {
      // Expired - remove it
      await setSessions(sessions.filter((s) => s.token !== token));
      return null;
    }

    return session;
  }

  async function deleteSession(token) {
    if (!token) return;
    const sessions = await getSessions();
    await setSessions(sessions.filter((s) => s.token !== token));
  }

  async function cleanupExpiredSessions() {
    const sessions = await getSessions();
    const now = new Date();
    const valid = sessions.filter((s) => new Date(s.expiresAt) > now);
    if (valid.length !== sessions.length) {
      await setSessions(valid);
    }
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
    findActiveAttempt,
    getAttempt,
    finishAttempt,
    saveAttempt,
    countStudentAttempts,
    // Accounts
    getAccounts,
    setAccounts,
    getAccountByLogin,
    getAccountById,
    // Sessions
    getSessions,
    setSessions,
    createSession,
    getSessionByToken,
    deleteSession,
    cleanupExpiredSessions,
  };
}

module.exports = { createDakStore };

