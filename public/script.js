// === Elements ===
const startBtn = document.getElementById("startBtn");
const userForm = document.getElementById("userForm");
const startScreen = document.getElementById("startScreen");
const quizScreen = document.getElementById("quizScreen");
const questionCard = document.getElementById("questionCard");
const navButtons = document.getElementById("navButtons");
const timerEl = document.getElementById("timer");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const submitBtn = document.getElementById("submitBtn");
const modal = document.getElementById("modal");
const modalMessage = document.getElementById("modalMessage");
const testTitleEl = document.getElementById("testTitle");
const testTypeEl = document.getElementById("testType");
const testImageEl = document.getElementById("testImage");
const liveTitleEl = document.getElementById("liveTestTitle");
const studentNameEl = document.getElementById("studentName");
const studentInitialEl = document.getElementById("studentInitial");
const restartBtn = document.getElementById("restartBtn"); // Yangi

let progressBarEl = null;

// === State ===
let questions = [];
let userAnswers = [];
let currentIndex = 0;
let durationSec = null;
let interval = null;
let userInfo = {};
let dataLoaded = false;
let started = false; // ⬅️ test faqat Start bosilganda boshlansin
const testId = window.location.pathname.split("/").pop();

// --- LocalStorage helpers ---
const K = (k) => `qz:${testId}:${k}`;
function saveSession() {
  localStorage.setItem(K("active"), "1");
  localStorage.setItem(K("answers"), JSON.stringify(userAnswers));
  localStorage.setItem(K("index"), String(currentIndex));
  localStorage.setItem(K("user"), JSON.stringify(userInfo));
  if (!localStorage.getItem(K("start"))) {
    localStorage.setItem(K("start"), String(Date.now()));
  }
}
function loadSession() {
  if (localStorage.getItem(K("active")) !== "1") return false;
  try {
    userAnswers = JSON.parse(localStorage.getItem(K("answers")) || "[]");
    currentIndex = parseInt(localStorage.getItem(K("index")) || "0", 10) || 0;
    userInfo = JSON.parse(localStorage.getItem(K("user")) || "{}");
    return true;
  } catch {
    return false;
  }
}
function clearSession() {
  ["active", "answers", "index", "user", "start"].forEach(k => localStorage.removeItem(K(k)));
}

// Shuffle helper (agar kerak bo‘lsa)
function shuffleArray(arr) {
  return arr
    .map(v => ({ v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ v }) => v);
}

// Talaba panelini yangilash
function paintStudent() {
  const name = (userInfo?.fullname || "").trim() || "Talaba";
  if (studentNameEl) studentNameEl.textContent = name;
  if (studentInitialEl) studentInitialEl.textContent = (name[0] || "T").toUpperCase();
}

// Formani oldingi qiymatlar bilan to‘ldirish (qulaylik uchun)
function prefillForm() {
  if (!userInfo) return;
  const f = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  f("fullname", userInfo.fullname);
  f("group", userInfo.group);
  f("university", userInfo.university);
  f("faculty", userInfo.faculty);
}

// === Test yuklab beruvchi funksiya (CACHE-BUSTER bilan) — yangi ===
async function loadTest(forceFresh = false) {
  const url = forceFresh
    ? `/api/tests/${testId}?t=${Date.now()}`
    : `/api/tests/${testId}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Test ma'lumotlari yuklanmadi");
  const data = await res.json();

  // meta
  const name = data.testName || data.testTitle || "Test";
  if (testTitleEl) testTitleEl.textContent = name;
  if (liveTitleEl) liveTitleEl.textContent = "📝 " + name;
  if (testTypeEl) testTypeEl.textContent = data.testType || "Test";
  if (testImageEl) testImageEl.src = data.testImage || "/images/default.png";

  durationSec = data.duration ? Number(data.duration) * 60 : null;

  // Server HAR SAFAR random subset beradi — shuni olamiz
  questions = Array.isArray(data.questions) ? data.questions : [];

  // default state (agar resume bo‘lmasa)
  userAnswers = Array(questions.length).fill(null);
  currentIndex = 0;

  dataLoaded = true;
}

// === Dastlab yuklash ===
loadTest(false)
  .then(() => {
    // ⬇️ Avtostart YO‘Q. Session bo‘lsa ham faqat formani to‘ldirib Start bosilganda boshlanadi.
    if (loadSession()) {
      prefillForm();
      paintStudent();
    }
    startBtn.disabled = !formFilled();
    addDecorations();
  })
  .catch(err => {
    console.error("❌ Test ma'lumotlari yuklanmadi:", err);
    alert("Test ma'lumotlari yuklanmadi. Keyinroq urinib ko‘ring.");
  });

// Form check
function formFilled() {
  return [...userForm.querySelectorAll("input")].every(i => i.value.trim() !== "");
}
userForm.addEventListener("input", () => {
  if (!dataLoaded) return;
  startBtn.disabled = !formFilled();
});

// Start test
startBtn.addEventListener("click", () => {
  if (!formFilled()) return; // ⬅️ forma to‘liq to‘lmaguncha boshlanmasin
  userInfo = {
    fullname: document.getElementById("fullname").value.trim(),
    group: document.getElementById("group").value.trim(),
    university: document.getElementById("university").value.trim(),
    faculty: document.getElementById("faculty").value.trim(),
  };
  localStorage.setItem(K("user"), JSON.stringify(userInfo));
  localStorage.setItem(K("active"), "1");
  localStorage.setItem(K("start"), String(Date.now()));

  // Server allaqachon random subset bergani uchun yana shuffle shart emas.
  userAnswers = Array(questions.length).fill(null);
  currentIndex = 0;

  startTest(false);
});

function startTest(resume = false) {
  started = true; // ⬅️ endi test boshlandi
  startScreen.classList.add("hidden");
  quizScreen.classList.remove("hidden");
  paintStudent();
  renderNavigation();
  showQuestion(currentIndex);
  if (durationSec != null) startTimer();
  saveSession();
}

// Timer
function startTimer() {
  if (timerEl) timerEl.classList.remove("hidden");
  clearInterval(interval);
  interval = setInterval(() => {
    const startTs = parseInt(localStorage.getItem(K("start")) || String(Date.now()), 10);
    const elapsed = Math.floor((Date.now() - startTs) / 1000);
    const remaining = durationSec - elapsed;
    if (remaining <= 0) {
      clearInterval(interval);
      updateProgressBar(1);
      submitQuiz();
      return;
    }
    const m = String(Math.floor(remaining / 60)).padStart(2, "0");
    const s = String(remaining % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `⏱ Vaqt: ${m}:${s}`;
    updateProgressBar(Math.max(0, Math.min(1, elapsed / durationSec)));
  }, 1000);
}

// Navigation
function renderNavigation() {
  navButtons.innerHTML = "";
  questions.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.textContent = i + 1;
    const answered = userAnswers[i] !== null;
    btn.className = `w-10 h-10 rounded-full font-bold ${answered ? "bg-green-500" : "bg-red-400"} text-white`;
    btn.addEventListener("click", () => {
      if (!started) return; // ⬅️ startdan oldin ishlar blok
      currentIndex = i;
      showQuestion(i);
      saveSession();
    });
    navButtons.appendChild(btn);
  });
}

// Show question
function showQuestion(index) {
  const q = questions[index] || {};
  const opts = Array.isArray(q.options) ? q.options : [];
  questionCard.innerHTML = `
    <h3 class="text-lg font-semibold mb-2">${index + 1}. ${escapeHTML(q.question || q.text || "")}</h3>
    <div class="space-y-2">
      ${opts.map((opt, i) => `
        <label class="block">
          <input type="radio" name="q${index}" value="${i}" ${userAnswers[index] === i ? "checked" : ""} class="mr-2">
          ${escapeHTML(opt.text ?? String(opt))}
        </label>`).join("")}
    </div>
  `;
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === questions.length - 1;
  document.querySelectorAll(`input[name="q${index}"]`).forEach(input => {
    input.addEventListener("change", e => {
      userAnswers[index] = parseInt(e.target.value, 10);
      renderNavigation();
      checkCompletion();
      saveSession();
    });
  });
}

function checkCompletion() {
  submitBtn.disabled = !userAnswers.every(v => v !== null);
}

prevBtn.addEventListener("click", () => {
  if (!started) return; // ⬅️
  if (currentIndex > 0) {
    currentIndex--;
    showQuestion(currentIndex);
    saveSession();
  }
});
nextBtn.addEventListener("click", () => {
  if (!started) return; // ⬅️
  if (currentIndex < questions.length - 1) {
    currentIndex++;
    showQuestion(currentIndex);
    saveSession();
  }
});

// Submit
submitBtn.addEventListener("click", () => {
  if (!started) return; // ⬅️
  submitQuiz();
});

function submitQuiz() {
  clearInterval(interval);
  let correct = 0;
  questions.forEach((q, i) => {
    if (q.options?.[userAnswers[i]]?.isCorrect) correct++;
  });
  const percent = Math.round((correct / questions.length) * 100);
  const startedAt = parseInt(localStorage.getItem(K("start")) || String(Date.now()), 10);
  const finishedAt = Date.now();
  const timeSpent = Math.floor((finishedAt - startedAt) / 1000);
  modalMessage.innerHTML = `
    <strong>${escapeHTML(userInfo.fullname || "")}</strong><br>
    Siz <strong>${correct} / ${questions.length}</strong> to‘g‘ri javob berdingiz.<br>
    Umumiy natija: <strong>${percent}%</strong>
  `;
  modal.classList.remove("hidden");
  const payload = {
    testId,
    fullname: userInfo.fullname || "",
    group: userInfo.group || "",
    university: userInfo.university || "",
    faculty: userInfo.faculty || "",
    score: percent,
    correct,
    total: questions.length,
    timeSpent,
    startedAt,
    finishedAt
  };
  clearSession();
  sendResultToServer(payload);
}

// "Yana boshlash" (modal) — SERVERDAN QAYTA YANGI SAVOLLAR OLISH
if (restartBtn) {
  restartBtn.addEventListener("click", async () => {
    try {
      clearSession();                 // auto-resume ni o‘chir
      await loadTest(true);           // serverdan yangi subset (cache-buster)
      // formani avvalgi ma’lumot bilan to‘ldiramiz (to‘rtala input)
      prefillForm();
      // start tugmasi faollashadi, foydalanuvchi bosadi — toza test boshlanadi
      if (userInfo?.fullname) startBtn.disabled = false;

      started = false; // ⬅️ qayta blok holatiga qaytamiz
      modal.classList.add("hidden");
      startScreen.classList.remove("hidden");
      quizScreen.classList.add("hidden");
      updateProgressBar(0);
    } catch (e) {
      console.error(e);
      // fallback
      localStorage.clear();
      location.reload();
    }
  });
}

async function sendResultToServer(resultObj) {
  try {
    const res = await fetch("/api/save-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resultObj)
    });
    console.log("✅ Natija yuborildi:", await res.json());
  } catch (err) {
    console.error("❌ Natija yuborishda xatolik:", err);
  }
}

// ⬇️ Faqat boshlanganda sessiyani saqlaymiz — aks holda "active" belgilanib, avtostart bo‘lib qolardi
window.addEventListener("beforeunload", () => {
  if (started) saveSession();
});

// Decorations
function createProgressBar() {
  if (progressBarEl) return;
  const sticky = document.querySelector("#quizScreen .sticky");
  if (!sticky) return;
  const barWrap = document.createElement("div");
  barWrap.style.height = "6px";
  barWrap.style.background = "transparent";
  barWrap.style.margin = "0 0 8px 0";
  barWrap.style.borderRadius = "9999px";
  barWrap.style.overflow = "hidden";
  const bar = document.createElement("div");
  bar.style.width = "0%";
  bar.style.height = "100%";
  bar.style.background = "linear-gradient(90deg,#22c55e,#3b82f6)";
  bar.style.transition = "width .35s linear";
  barWrap.appendChild(bar);
  sticky.insertBefore(barWrap, sticky.firstChild);
  progressBarEl = bar;
}
function updateProgressBar(ratio) {
  if (!progressBarEl) return;
  progressBarEl.style.width = Math.max(0, Math.min(100, ratio * 100)) + "%";
}

// Fon naqshlari — kontent tagida, kartalarga urilmaydi
function addSvgPattern() {
  if (document.getElementById("svgPatternBg")) return;
  const svg = encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 40 40'>
      <defs>
        <pattern id='p' x='0' y='0' width='10' height='10' patternUnits='userSpaceOnUse'>
          <circle cx='1' cy='1' r='1' fill='rgba(99,102,241,0.12)'/>
        </pattern>
      </defs>
      <rect width='100%' height='100%' fill='url(#p)'/>
    </svg>
  `);
  const div = document.createElement("div");
  div.id = "svgPatternBg";
  div.style.position = "fixed";
  div.style.inset = "0";
  div.style.pointerEvents = "none";
  div.style.zIndex = "-2";
  div.style.backgroundImage = `url("data:image/svg+xml,${svg}")`;
  div.style.opacity = "0.5";
  document.body.appendChild(div);
}
function addNoiseOverlay() {
  if (document.getElementById("noiseOverlay")) return;
  const svg = encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'>
      <filter id='n'>
        <feTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='2' stitchTiles='stitch'/>
        <feColorMatrix type='saturate' values='0'/>
        <feComponentTransfer><feFuncA type='linear' slope='0.03'/></feComponentTransfer>
      </filter>
      <rect width='100%' height='100%' filter='url(#n)'/>
    </svg>
  `);
  const div = document.createElement("div");
  div.id = "noiseOverlay";
  div.style.position = "fixed";
  div.style.inset = "0";
  div.style.pointerEvents = "none";
  div.style.zIndex = "-3";
  div.style.backgroundImage = `url("data:image/svg+xml,${svg}")`;
  div.style.opacity = "0.25";
  document.body.appendChild(div);
}
function addDecorations() {
  if (startScreen) { startScreen.style.position = "relative"; startScreen.style.zIndex = "1"; }
  if (quizScreen)  { quizScreen.style.position  = "relative"; quizScreen.style.zIndex  = "1"; }
  addSvgPattern();
  addNoiseOverlay();
  createProgressBar();
}

// Util
function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
