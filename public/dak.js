(() => {
  const UNIVERSITY = "Oriental Universiteti";

  const el = (id) => document.getElementById(id);
  const checkinSection = el("checkinSection");
  const examSection = el("examSection");
  const resultSection = el("resultSection");

  // Login form elements
  const loginForm = el("loginForm");
  const studentInfo = el("studentInfo");
  const loginInput = el("loginInput");
  const passwordInput = el("passwordInput");
  const loginBtn = el("loginBtn");
  const logoutBtn = el("logoutBtn");
  const startBtn = el("startBtn");
  const checkinError = el("checkinError");

  // Info display elements
  const infoUniversity = el("infoUniversity");
  const infoExamDate = el("infoExamDate");
  const infoProgram = el("infoProgram");
  const infoGroup = el("infoGroup");
  const infoFullName = el("infoFullName");

  const infoLine1 = el("infoLine1");
  const infoLine2 = el("infoLine2");
  const timerText = el("timerText");
  const progressText = el("progressText");
  const qIndexText = el("qIndexText");
  const qTotalText = el("qTotalText");
  const questionText = el("questionText");
  const optionsWrap = el("optionsWrap");
  const navGrid = el("navGrid");
  const prevBtn = el("prevBtn");
  const nextBtn = el("nextBtn");
  const finishBtn = el("finishBtn");
  const examError = el("examError");

  const scoreText = el("scoreText");
  const correctText = el("correctText");
  const totalText = el("totalText");
  const congratsText = el("congratsText");
  const backToCheckinBtn = el("backToCheckinBtn");
  const retryContainer = el("retryContainer");
  const retryHint = el("retryHint");
  const participantName = el("participantName");
  const examInfo = el("examInfo");
  const timeSpentCard = el("timeSpentCard");
  const timeSpentText = el("timeSpentText");

  const LS_ATTEMPT_ID = "dak_attempt_id";
  let maxAttemptsConfig = 1; // o'qituvchi tomonidan belgilangan urinishlar soni

  let attemptId = null;
  let attemptMeta = null;
  let questions = [];
  let answers = {};
  let currentIndex = 0;
  let timerInterval = null;
  let currentUserMeta = null; // Logged in user's meta data

  function showError(targetEl, message) {
    if (!targetEl) return;
    targetEl.textContent = message || "";
    targetEl.classList.toggle("hidden", !message);
  }

  function answeredCount() {
    if (!answers || typeof answers !== "object") return 0;
    // faqat haqiqiy indexlar (0..len-1) sanalsin
    const max = questions.length;
    let c = 0;
    for (const k of Object.keys(answers)) {
      const i = parseInt(k, 10);
      if (Number.isFinite(i) && i >= 0 && i < max) c++;
    }
    return c;
  }

  function allAnswered() {
    return questions.length > 0 && answeredCount() >= questions.length;
  }

  function updateFinishState() {
    if (!finishBtn) return;
    const ok = allAnswered();
    finishBtn.disabled = !ok;
    finishBtn.title = ok ? "" : "Yakunlash faqat barcha savollarga javob berilgandan keyin ishlaydi";
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data;
  }

  function setSelectOptions(selectEl, items, valueKey, labelKey) {
    selectEl.innerHTML = `<option value=\"\">Tanlang...</option>`;
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item[valueKey];
      opt.textContent = item[labelKey];
      selectEl.appendChild(opt);
    }
  }

  function fmtMMSS(sec) {
    const s = Math.max(0, Math.floor(sec));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function clearTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  function startTimer(startedAtIso, durationMinutes) {
    clearTimer();
    const startedAt = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
    const totalSec = Math.max(1, parseInt(durationMinutes, 10)) * 60;

    const tick = async () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const left = Math.max(0, totalSec - elapsed);
      timerText.textContent = fmtMMSS(left);
      if (left <= 0) {
        clearTimer();
        try {
          await finishExam(true);
        } catch {}
      }
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function setMode(mode) {
    if (mode === "checkin") {
      checkinSection.classList.remove("hidden");
      examSection.classList.add("hidden");
      resultSection.classList.add("hidden");
    } else if (mode === "exam") {
      checkinSection.classList.add("hidden");
      examSection.classList.remove("hidden");
      resultSection.classList.add("hidden");
    } else if (mode === "result") {
      checkinSection.classList.add("hidden");
      examSection.classList.add("hidden");
      resultSection.classList.remove("hidden");
    }
  }

  function renderNav() {
    navGrid.innerHTML = "";
    for (let i = 0; i < questions.length; i++) {
      const btn = document.createElement("button");
      const answered = answers[String(i)] !== undefined;
      const isCurrent = i === currentIndex;
      const stateClass = isCurrent
        ? "bg-blue-600 text-white border-blue-700/30"
        : answered
          ? "bg-white border-slate-200 hover:bg-sky-50 text-slate-900"
          : "bg-white border-red-200 hover:bg-red-50 text-red-700";
      const answeredClasses = answered
        ? ["ring-2", "ring-green-200", ...(isCurrent ? [] : ["border-green-300"])]
        : [];
      btn.className = [
        "text-sm px-2 py-1.5 rounded-lg border transition focus:outline-none focus:ring-4 focus:ring-blue-100",
        stateClass,
        ...answeredClasses
      ].join(" ");
      btn.textContent = String(i + 1);
      btn.addEventListener("click", () => {
        currentIndex = i;
        renderQuestion();
      });
      navGrid.appendChild(btn);
    }
  }

  function renderQuestion() {
    showError(examError, "");
    const q = questions[currentIndex];
    if (!q) return;

    qIndexText.textContent = String(currentIndex + 1);
    qTotalText.textContent = String(questions.length);
    questionText.textContent = q.question || "";

    const selected = answers[String(currentIndex)];
    const opts = Array.isArray(q.options) ? q.options : [];

    optionsWrap.innerHTML = "";
    opts.forEach((o, idx) => {
      const row = document.createElement("button");
      const active = selected === idx;
      row.className = [
        "w-full text-left p-4 rounded-xl border flex gap-3 items-start transition focus:outline-none focus:ring-4 focus:ring-blue-100",
        active
          ? "bg-green-50 border-green-300 shadow-sm"
          : "bg-white border-slate-200 hover:bg-sky-50"
      ].join(" ");
      const optionText = typeof o === "string" ? o : (o?.text || "");
      const indicator = document.createElement("div");
      indicator.className = [
        "mt-1 w-5 h-5 rounded-full border flex items-center justify-center",
        active ? "border-green-600" : "border-slate-300"
      ].join(" ");

      const dot = document.createElement("div");
      dot.className = ["w-2.5 h-2.5 rounded-full", active ? "bg-green-600" : "bg-transparent"].join(" ");
      indicator.appendChild(dot);

      const textDiv = document.createElement("div");
      textDiv.className = "text-slate-900 leading-relaxed";
      textDiv.textContent = optionText;

      row.appendChild(indicator);
      row.appendChild(textDiv);
      row.addEventListener("click", async () => {
        try {
          answers[String(currentIndex)] = idx;
          renderQuestion();
          renderNav();
          progressText.textContent = `${answeredCount()}/${questions.length}`;
          updateFinishState();
          await apiJson(`/api/public/dak/attempt/${encodeURIComponent(attemptId)}/answer`, {
            method: "POST",
            body: JSON.stringify({ question_index: currentIndex, chosen_option: idx }),
          });
        } catch (e) {
          showError(examError, e.message || "Xatolik");
        }
      });
      optionsWrap.appendChild(row);
    });

    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= questions.length - 1;
    progressText.textContent = `${answeredCount()}/${questions.length}`;
    updateFinishState();
  }

  // =========================
  // Auth functions
  // =========================
  function showLoginForm() {
    if (loginForm) loginForm.classList.remove("hidden");
    if (studentInfo) studentInfo.classList.add("hidden");
  }

  function showStudentInfo(meta) {
    if (loginForm) loginForm.classList.add("hidden");
    if (studentInfo) studentInfo.classList.remove("hidden");

    if (infoUniversity) infoUniversity.textContent = meta.university || UNIVERSITY;
    if (infoExamDate) infoExamDate.textContent = meta.exam_date || "";
    if (infoProgram) infoProgram.textContent = meta.program || "";
    if (infoGroup) infoGroup.textContent = meta.group || "";
    if (infoFullName) infoFullName.textContent = meta.full_name || "";
  }

  async function doLogin() {
    showError(checkinError, "");
    const login = (loginInput?.value || "").trim();
    const password = (passwordInput?.value || "").trim();

    if (!login || !password) {
      showError(checkinError, "Login va parolni kiriting.");
      return;
    }

    try {
      const res = await apiJson("/api/public/dak/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password }),
      });

      if (res.ok && res.meta) {
        currentUserMeta = res.meta;
        showStudentInfo(res.meta);
      }
    } catch (e) {
      showError(checkinError, e.message || "Kirish xatosi");
    }
  }

  async function doLogout() {
    try {
      await apiJson("/api/public/dak/auth/logout", { method: "POST" });
    } catch {}
    currentUserMeta = null;
    if (loginInput) loginInput.value = "";
    if (passwordInput) passwordInput.value = "";
    showLoginForm();
    showError(checkinError, "");
  }

  async function checkAuth() {
    try {
      const res = await apiJson("/api/public/dak/auth/me", { cache: "no-store" });
      if (res.ok && res.meta) {
        currentUserMeta = res.meta;
        showStudentInfo(res.meta);
        return true;
      }
    } catch {}
    showLoginForm();
    return false;
  }

  async function startExam() {
    showError(checkinError, "");

    if (!currentUserMeta) {
      showError(checkinError, "Avval tizimga kiring.");
      return;
    }

    const examMode = await apiJson("/api/public/exam-mode", { cache: "no-store" });
    if (!examMode?.enabled) {
      showError(checkinError, "Imtihon rejimi hozir OFF. O'qituvchi yoqishini kuting.");
      return;
    }

    const start = await apiJson("/api/public/dak/start", {
      method: "POST",
      body: JSON.stringify({}), // Server will use session data
    });
    attemptId = start.attempt_id;
    if (!attemptId) throw new Error("attempt_id qaytmadi");

    localStorage.setItem(LS_ATTEMPT_ID, attemptId);
    await loadAttempt(attemptId);
  }

  async function loadAttempt(id) {
    attemptId = id;
    showError(checkinError, "");
    showError(examError, "");

    const data = await apiJson(`/api/public/dak/attempt/${encodeURIComponent(id)}/questions`, { cache: "no-store" });
    attemptMeta = data;
    questions = Array.isArray(data.questions) ? data.questions : [];
    answers = data.answers && typeof data.answers === "object" ? data.answers : {};
    currentIndex = 0;

    const prog = currentUserMeta?.program || attemptMeta.program_name || "";
    const grp = attemptMeta.group_name || currentUserMeta?.group || "";
    const fish = attemptMeta.student_fullname || currentUserMeta?.full_name || "";
    const date = attemptMeta.exam_date || currentUserMeta?.exam_date || "";

    infoLine1.textContent = `${UNIVERSITY} / ${prog} / ${grp}`;
    infoLine2.textContent = `${fish} / Sana: ${date}`;

    qTotalText.textContent = String(questions.length || 0);
    renderNav();
    renderQuestion();
    startTimer(attemptMeta.started_at, attemptMeta.duration_minutes || 80);
    updateFinishState();

    setMode("exam");
  }

  async function finishExam(auto = false) {
    if (!attemptId) return;
    if (!auto && !allAnswered()) {
      showError(examError, `Yakunlash uchun barcha ${questions.length || 50} ta savolga javob belgilang.`);
      updateFinishState();
      return;
    }
    if (!auto) {
      if (!confirm("Imtihonni yakunlaysizmi?")) return;
    }

    const res = await apiJson(`/api/public/dak/attempt/${encodeURIComponent(attemptId)}/finish`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    clearTimer();
    const score = res.score_points ?? 0;
    const correct = res.correct_count ?? 0;
    const total = res.total_questions ?? questions.length ?? 0;

    // Score va statistika
    if (scoreText) scoreText.textContent = String(score);
    if (correctText) correctText.textContent = String(correct);
    if (totalText) totalText.textContent = String(total);

    // Tabriklov xabari
    const fish = attemptMeta?.student_fullname || "";
    if (congratsText) {
      const emoji = score >= 80 ? "🎉" : score >= 60 ? "👍" : "💪";
      congratsText.textContent = `${emoji} Tabriklaymiz, ${fish}! Siz ${score} ball to'pladingiz.`;
    }

    // Ishtirokchi nomi
    if (participantName) {
      participantName.textContent = fish;
    }

    // Imtihon ma'lumotlari
    if (examInfo) {
      const examDate = attemptMeta?.exam_date || "";
      examInfo.textContent = `DAK | Sana: ${examDate}`;
    }

    // Sarflangan vaqt (agar ma'lumot bo'lsa)
    if (timeSpentCard && timeSpentText && attemptMeta?.started_at) {
      const startedAt = new Date(attemptMeta.started_at).getTime();
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      timeSpentText.textContent = `${mm}:${ss}`;
      timeSpentCard.classList.remove("hidden");
    }

    // Qaytadan topshirish tugmasini faqat max_attempts > 1 bo'lganda ko'rsatish
    if (retryContainer) {
      if (maxAttemptsConfig > 1) {
        retryContainer.classList.remove("hidden");
        if (retryHint) {
          retryHint.textContent = `Sizga jami ${maxAttemptsConfig} marta urinish imkoniyati berilgan`;
        }
      } else {
        retryContainer.classList.add("hidden");
      }
    }

    localStorage.removeItem(LS_ATTEMPT_ID);
    setMode("result");
  }

  function resetAll() {
    clearTimer();
    attemptId = null;
    attemptMeta = null;
    questions = [];
    answers = {};
    currentIndex = 0;
    localStorage.removeItem(LS_ATTEMPT_ID);
    // Stay logged in, just go back to checkin
    if (currentUserMeta) {
      showStudentInfo(currentUserMeta);
    } else {
      showLoginForm();
    }
    setMode("checkin");
  }

  async function loadDakConfig() {
    try {
      const cfg = await apiJson("/api/public/dak/config", { cache: "no-store" });
      maxAttemptsConfig = cfg?.max_attempts_per_student || 1;
    } catch {
      maxAttemptsConfig = 1;
    }
  }

  async function init() {
    // Login button event
    if (loginBtn) {
      loginBtn.addEventListener("click", () => doLogin().catch((e) => showError(checkinError, e.message)));
    }

    // Allow Enter key to submit login
    if (passwordInput) {
      passwordInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doLogin().catch((e) => showError(checkinError, e.message));
        }
      });
    }
    if (loginInput) {
      loginInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doLogin().catch((e) => showError(checkinError, e.message));
        }
      });
    }

    // Logout button event
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => doLogout());
    }

    // Start exam button
    if (startBtn) {
      startBtn.addEventListener("click", () => startExam().catch((e) => showError(checkinError, e.message)));
    }

    prevBtn.addEventListener("click", () => {
      if (currentIndex > 0) {
        currentIndex--;
        renderQuestion();
        renderNav();
      }
    });
    nextBtn.addEventListener("click", () => {
      if (currentIndex < questions.length - 1) {
        currentIndex++;
        renderQuestion();
        renderNav();
      }
    });
    finishBtn.addEventListener("click", () => finishExam(false).catch((e) => showError(examError, e.message)));

    // Klaviatura yo'nalish tugmalari bilan navigatsiya
    document.addEventListener("keydown", (e) => {
      // Faqat imtihon rejimida ishlaydi
      if (examSection.classList.contains("hidden")) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentIndex > 0) {
          currentIndex--;
          renderQuestion();
          renderNav();
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (currentIndex < questions.length - 1) {
          currentIndex++;
          renderQuestion();
          renderNav();
        }
      }
    });

    backToCheckinBtn.addEventListener("click", () => resetAll());

    // Config dan max_attempts ni olish
    await loadDakConfig();

    // Check if already authenticated
    await checkAuth();

    // Check for saved attempt
    const savedAttempt = localStorage.getItem(LS_ATTEMPT_ID);
    if (savedAttempt) {
      try {
        await loadAttempt(savedAttempt);
      } catch {
        localStorage.removeItem(LS_ATTEMPT_ID);
      }
    }

    updateFinishState();
  }

  init().catch((e) => showError(checkinError, e.message || "Xatolik"));
})();
