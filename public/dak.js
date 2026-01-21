(() => {
  const UNIVERSITY = "Oriental Universiteti";

  const el = (id) => document.getElementById(id);
  const checkinSection = el("checkinSection");
  const examSection = el("examSection");
  const resultSection = el("resultSection");

  const universityInput = el("universityInput");
  const examDateInput = el("examDateInput");
  const programSelect = el("programSelect");
  const groupSelect = el("groupSelect");
  const studentSelect = el("studentSelect");
  const startBtn = el("startBtn");
  const checkinError = el("checkinError");
  const checkinHint = el("checkinHint");

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

  const LS_ATTEMPT_ID = "dak_attempt_id";

  let attemptId = null;
  let attemptMeta = null;
  let questions = [];
  let answers = {};
  let currentIndex = 0;
  let timerInterval = null;

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

  async function loadPrograms() {
    const programs = await apiJson("/api/public/dak/programs", { cache: "no-store" });
    setSelectOptions(programSelect, Array.isArray(programs) ? programs : [], "program_id", "program_name");
  }

  async function onProgramChange() {
    groupSelect.disabled = true;
    studentSelect.disabled = true;
    examDateInput.value = "";
    groupSelect.innerHTML = `<option value=\"\">Tanlang...</option>`;
    studentSelect.innerHTML = `<option value=\"\">Tanlang...</option>`;

    const program_id = programSelect.value;
    if (!program_id) return;
    const groups = await apiJson(`/api/public/dak/groups?program_id=${encodeURIComponent(program_id)}`, { cache: "no-store" });
    setSelectOptions(groupSelect, Array.isArray(groups) ? groups : [], "group_name", "group_name");
    groupSelect.disabled = false;
  }

  let lastGroupExamDate = "";

  async function onGroupChange() {
    studentSelect.disabled = true;
    examDateInput.value = "";
    studentSelect.innerHTML = `<option value=\"\">Tanlang...</option>`;
    lastGroupExamDate = "";

    const program_id = programSelect.value;
    const group_name = groupSelect.value;
    if (!program_id || !group_name) return;
    const students = await apiJson(
      `/api/public/dak/students?program_id=${encodeURIComponent(program_id)}&group_name=${encodeURIComponent(group_name)}`,
      { cache: "no-store" }
    );
    const items = Array.isArray(students) ? students : [];
    lastGroupExamDate = items[0]?.exam_date || "";
    studentSelect.innerHTML = `<option value=\"\">Tanlang...</option>`;
    for (const s of items) {
      const opt = document.createElement("option");
      opt.value = s.fullname;
      opt.textContent = s.fullname;
      studentSelect.appendChild(opt);
    }
    studentSelect.disabled = false;
  }

  function onStudentChange() {
    examDateInput.value = lastGroupExamDate || "";
  }

  async function startExam() {
    showError(checkinError, "");
    const program_id = programSelect.value;
    const group_name = groupSelect.value;
    const student_fullname = studentSelect.value;

    if (!program_id || !group_name || !student_fullname) {
      showError(checkinError, "Iltimos, yo‘nalish, guruh va F.I.Sh ni tanlang.");
      return;
    }

    const examMode = await apiJson("/api/public/exam-mode", { cache: "no-store" });
    if (!examMode?.enabled) {
      showError(checkinError, "Imtihon rejimi hozir OFF. O‘qituvchi yoqishini kuting.");
      return;
    }

    const start = await apiJson("/api/public/dak/start", {
      method: "POST",
      body: JSON.stringify({ program_id, group_name, student_fullname }),
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

    const prog = programSelect.selectedOptions?.[0]?.textContent || attemptMeta.program_name || "";
    const grp = attemptMeta.group_name || groupSelect.value || "";
    const fish = attemptMeta.student_fullname || studentSelect.value || "";
    const date = attemptMeta.exam_date || examDateInput.value || "";

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

    scoreText.textContent = String(score);
    correctText.textContent = String(correct);
    totalText.textContent = String(total);
    if (congratsText) {
      const fish = attemptMeta?.student_fullname || "";
      congratsText.textContent = `Tabriklaymiz ${fish} siz ${score} ball to'pladingiz`;
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
    examDateInput.value = "";
    programSelect.value = "";
    groupSelect.value = "";
    studentSelect.value = "";
    groupSelect.disabled = true;
    studentSelect.disabled = true;
    localStorage.removeItem(LS_ATTEMPT_ID);
    setMode("checkin");
  }

  async function init() {
    universityInput.value = UNIVERSITY;
    examDateInput.value = "";
    checkinHint.textContent = "Eslatma: sahifa yangilansa ham savollar o‘zgarmaydi (attempt saqlanadi).";

    programSelect.addEventListener("change", () => onProgramChange().catch((e) => showError(checkinError, e.message)));
    groupSelect.addEventListener("change", () => onGroupChange().catch((e) => showError(checkinError, e.message)));
    studentSelect.addEventListener("change", onStudentChange);
    startBtn.addEventListener("click", () => startExam().catch((e) => showError(checkinError, e.message)));

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

    backToCheckinBtn.addEventListener("click", () => resetAll());

    await loadPrograms();

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
