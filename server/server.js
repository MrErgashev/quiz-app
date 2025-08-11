// === Boshlanishi ===
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const { google } = require("googleapis");
const XLSX = require("xlsx");
const parser = require("./parser");
require('dotenv').config();

require("./auth/passport");

const app = express();
const PORT = process.env.PORT || 3000; // ⬅️ FLY.IO uchun PORT muhit o'zgaruvchisi

// --- Helpers ---
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const safeUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} };

// Urinishlar cheklovi (bitta device uchun) — HOZIRCHA FOYDLANILMAYDI
const MAX_ATTEMPTS_PER_DEVICE = 1; // xohlasangiz 2 qiling (hozir /api/save-result da ishlatilmaydi)

const DATA_DIR = path.join(__dirname, "../data");
const TESTS_DIR = path.join(DATA_DIR, "tests");
const RESULTS_DIR = path.join(DATA_DIR, "results");
const UPLOADS_DIR = path.join(__dirname, "../public/uploads");
ensureDir(DATA_DIR); ensureDir(TESTS_DIR); ensureDir(RESULTS_DIR); ensureDir(UPLOADS_DIR);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "super-secret-key",
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
// public/ (shu jumladan /uploads) fayllarni statik berish
app.use(express.static(path.join(__dirname, "../public")));

// ⬇️ Multer temporar papkani public/uploads ga yo'naltirdik
const upload = multer({ dest: UPLOADS_DIR });

function getDriveClient(tokens = {}) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token
  });
  return google.drive({ version: "v3", auth });
}

// 🔐 Google Login
app.get("/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email", "https://www.googleapis.com/auth/drive.file"]
  })
);

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/dashboard.html")
);

app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/logout.html"));
});

// 👤 O‘qituvchi ma’lumotini olish
app.get("/api/user", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");
  res.json({
    name: req.user.displayName,
    email: req.user.emails?.[0]?.value || req.user.email,
    photo: req.user.photo
  });
});

// 📤 Test yuklash (txt + rasm) + tasodifiy N ta savolni saqlash
app.post(
  "/api/upload-test",
  upload.fields([
    { name: "file",  maxCount: 1 },   // Test savollari (.txt)
    { name: "image", maxCount: 1 }    // Test rasmi (jpg/png)
  ]),
  async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");

    const { testName, duration, questionCount } = req.body;
    const file = req.files.file?.[0];
    const imageFile = req.files.image?.[0];
    const user = req.user;

    try {
      if (!file) return res.status(400).json({ error: "Fayl topilmadi" });

      // 1) Savollarni parse qilish
      const text = fs.readFileSync(file.path, "utf-8");
      const allQuestions = parser.parseQuestions(text);
      if (!Array.isArray(allQuestions) || allQuestions.length === 0) {
        return res.status(400).json({ error: "❌ Savollarni parsing qilishda xatolik" });
      }

      // 2) N ta tasodifiy savolga kesish (saqlash uchun eski maydonni ham qoldiramiz)
      const desired = Math.max(
        1,
        Math.min(
          parseInt(questionCount || allQuestions.length, 10) || allQuestions.length,
          allQuestions.length
        )
      );
      const questions = [...allQuestions].sort(() => Math.random() - 0.5).slice(0, desired);

      // 3) Rasmni /public/uploads ga ko‘chirish
      const id = crypto.randomBytes(5).toString("hex");
      let imagePath = null;
      if (imageFile) {
        const ext = path.extname(imageFile.originalname) || ".jpg";
        const newName = `${id}${ext}`;
        fs.renameSync(imageFile.path, path.join(UPLOADS_DIR, newName));
        imagePath = `/uploads/${newName}`; // public orqali beriladi
      }

      // 4) JSONni saqlash (createdAt qo‘shildi, va ENG MUHIMI: allQuestions ham qo‘shildi)
      const userEmail = user.emails?.[0]?.value || user.email;
      const saveJsonPath = path.join(TESTS_DIR, `test_${id}.json`);
      fs.writeFileSync(
        saveJsonPath,
        JSON.stringify(
          {
            testTitle: testName,
            testType: "Yangi yuklangan test",
            time: parseInt(duration, 10), // daqiqa
            questionCount: desired,
            testImage: imagePath,
            questions,                    // eski maydon — qoldirildi
            allQuestions,                 // yangi: to‘liq bank — clientga randomlab beramiz
            createdAt: Date.now(),        // tartiblash uchun
            createdBy: { email: userEmail, name: user.displayName }
          },
          null,
          2
        )
      );

      // 5) .txt faylni Google Drive’ga yuklash (best-effort)
      try {
        const drive = getDriveClient(user.tokens);
        await drive.files.create({
          requestBody: { name: `${testName}_${Date.now()}.txt`, parents: ['root'] },
          media: { mimeType: "text/plain", body: fs.createReadStream(file.path) }
        });
      } catch (e) {
        console.warn("Drive yuklash ogohlantirish:", e.message);
      } finally {
        try { fs.unlinkSync(file.path); } catch {}
      }

      res.json({ message: "✅ Test yuklandi!", testId: id, testLink: `/test/${id}` });
    } catch (err) {
      console.error("❌ /api/upload-test xatolik:", err);
      res.status(500).send("Yuklab bo‘lmadi.");
    }
  }
);

// 📄 Test sahifasi
app.get("/test/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/test.html"));
});

// 📚 AJAX test (eski)
app.get("/api/test/:id", (req, res) => {
  const id = req.params.id;
  const filePath = path.join(TESTS_DIR, `test_${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "❌ Test topilmadi" });

  const data = fs.readFileSync(filePath, "utf-8");
  res.json(JSON.parse(data));
});

// 🆕 Talaba uchun test ma’lumotlari — HAR CHAQIRILGANDA TASODIFIY TANLAB QAYTARAMIZ
app.get("/api/tests/:id", (req, res) => {
  const id = req.params.id;
  const filePath = path.join(TESTS_DIR, `test_${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "❌ Test topilmadi" });

  try {
    // 🔒 Brauzer keshlamasligi uchun kuchli headerlar
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    // Pool: agar allQuestions bo'lsa — o'shandan, bo'lmasa — questions dan
    const pool = Array.isArray(data.allQuestions) && data.allQuestions.length
      ? data.allQuestions
      : (Array.isArray(data.questions) ? data.questions : []);

    const desired = Math.max(1, Math.min(data.questionCount || pool.length, pool.length));

    // Har chaqiriqda tasodifiy N tanlash (deterministik bo‘lmasin)
    const shuffled = pool
      .map(v => ({ v, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .slice(0, desired)
      .map(({ v }) => v);

    res.json({
      testName: data.testTitle,
      testType: data.testType || "Test",
      duration: data.time,                    // daqiqa
      questionCount: shuffled.length,
      testImage: data.testImage || null,
      questions: shuffled
    });
  } catch (e) {
    console.error("GET /api/tests/:id error:", e);
    res.status(500).json({ error: "Xatolik" });
  }
});

// 📊 Natijani saqlash (+ Excel + Drive) — startedAt/finishedAt bilan
// DIQQAT: device limit tekshiruvi olib tashlandi (talab bo‘yicha)
app.post("/api/save-result", async (req, res) => {
  const result = req.body; // { deviceId?, startedAt, finishedAt, ... }
  const fileName = `result_${result.testId}_${Date.now()}.json`;
  const savePath = path.join(RESULTS_DIR, fileName);

  try {
    // JSON saqlash
    fs.writeFileSync(savePath, JSON.stringify(result, null, 2));

    // Excel (drivega ham yuboramiz)
    const toDate = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };
    const toTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      const HH = String(d.getHours()).padStart(2, "0");
      const MM = String(d.getMinutes()).padStart(2, "0");
      const SS = String(d.getSeconds()).padStart(2, "0");
      return `${HH}:${MM}:${SS}`;
    };

    const xlsName = fileName.replace(".json", ".xlsx");
    const ws = XLSX.utils.json_to_sheet([{
      FISH: result.fullname,
      Guruh: result.group,
      Universitet: result.university,
      Yonalish: result.faculty,
      Togri: result.correct,
      Umumiy: result.total,
      Foiz: (result.score ?? 0) + "%",
      BoshlaganSana: toDate(result.startedAt),
      BoshlaganVaqt: toTime(result.startedAt),
      TugatganSana: toDate(result.finishedAt),
      TugatganVaqt: toTime(result.finishedAt),
      Vaqt_sarfi: Math.floor((result.timeSpent ?? 0) / 60) + " daq " + ((result.timeSpent ?? 0) % 60) + " sek"
    }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Natija");
    const xlsBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const xlsPath = path.join(RESULTS_DIR, xlsName);
    fs.writeFileSync(xlsPath, xlsBuffer);

    // Drive (agar login bo'lsa) — best-effort
    if (req.isAuthenticated()) {
      try {
        const drive = getDriveClient(req.user.tokens);
        await drive.files.create({
          requestBody: { name: xlsName, parents: ['root'] },
          media: {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: fs.createReadStream(xlsPath)
          }
        });
      } catch (e) {
        console.warn("Drive ga natija yuborishda ogohlantirish:", e.message);
      }
    }

    res.status(200).json({ message: "✅ Natija saqlandi", fileName });
  } catch (err) {
    console.error("❌ Natijani saqlashda xatolik:", err);
    res.status(500).send("Xatolik");
  }
});

// 📥 TEST STATISTIKASINI YUKLAB BERISH (o‘qituvchi uchun, umumiy xlsx)
app.get("/api/export/:id", (req, res) => {
  const testId = req.params.id;
  if (!fs.existsSync(RESULTS_DIR)) return res.status(404).send("Natijalar topilmadi");

  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith(".json"));
  const rows = [];

  const splitDateTime = (ts) => {
    if (!ts) return { date: "", time: "" };
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const HH = String(d.getHours()).padStart(2, "0");
    const MM = String(d.getMinutes()).padStart(2, "0");
    const SS = String(d.getSeconds()).padStart(2, "0");
    return { date: `${yyyy}-${mm}-${dd}`, time: `${HH}:${MM}:${SS}` };
  };

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf-8"));
      if (data.testId !== testId) continue;

      const start = splitDateTime(data.startedAt);
      const end   = splitDateTime(data.finishedAt);

      rows.push({
        FISH: data.fullname || "",
        Guruh: data.group || "",
        Universitet: data.university || "",
        Yonalish: data.faculty || "",
        Togri: data.correct ?? 0,
        Umumiy: data.total ?? 0,
        Foiz: (data.score ?? 0) + "%",
        BoshlaganSana: start.date,
        BoshlaganVaqt: start.time,
        TugatganSana: end.date,
        TugatganVaqt: end.time,
        Vaqt_sarfi: Math.floor((data.timeSpent ?? 0) / 60) + " daq " + ((data.timeSpent ?? 0) % 60) + " sek"
      });
    } catch (e) {
      console.warn("⚠️ Natija fayli o‘qilmadi:", f, e.message);
    }
  }

  if (rows.length === 0) return res.status(404).send("Ushbu test uchun natijalar topilmadi.");

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Statistika");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="stats_${testId}.xlsx"`);
  res.send(buffer);
});

// 🗑️ Bitta testni o‘chirish (faqat egasi)
app.delete("/api/tests/:id", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  const testId = req.params.id;
  const jsonPath = path.join(TESTS_DIR, `test_${testId}.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).send("Test topilmadi");

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const ownerEmail = data?.createdBy?.email || "";
    const me = req.user.emails?.[0]?.value || req.user.email;
    if (ownerEmail !== me) return res.status(403).send("Ruxsat yo‘q");

    // Rasmni o‘chir
    if (data.testImage && data.testImage.startsWith("/uploads/")) {
      const imgAbs = path.join(__dirname, "../public", data.testImage);
      safeUnlink(imgAbs);
    }

    // Natijalarni o‘chir (shu testga tegishli)
    if (fs.existsSync(RESULTS_DIR)) {
      const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith(".json"));
      files.forEach(f => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf-8"));
          if (r.testId === testId) {
            safeUnlink(path.join(RESULTS_DIR, f));
            const xlsx = f.replace(".json", ".xlsx");
            safeUnlink(path.join(RESULTS_DIR, xlsx));
          }
        } catch {}
      });
    }

    // Test JSON’ini o‘chir
    safeUnlink(jsonPath);
    res.json({ ok: true, message: "Test o‘chirildi" });
  } catch (e) {
    console.error("DELETE /api/tests/:id xatolik:", e);
    res.status(500).send("Xatolik");
  }
});

// 🗑️ O‘qituvchining hamma testlarini o‘chirish (faqat o‘ziga tegishli)
app.delete("/api/tests", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  const me = req.user.emails?.[0]?.value || req.user.email;
  if (!fs.existsSync(TESTS_DIR)) return res.json({ ok: true, deleted: 0 });

  let count = 0;

  fs.readdirSync(TESTS_DIR).forEach(f => {
    if (!f.endsWith(".json")) return;
    try {
      const p = path.join(TESTS_DIR, f);
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (data?.createdBy?.email !== me) return;

      // rasm
      if (data.testImage && data.testImage.startsWith("/uploads/")) {
        const imgAbs = path.join(__dirname, "../public", data.testImage);
        safeUnlink(imgAbs);
      }

      // natijalar
      const testId = f.split("_")[1].split(".")[0];
      if (fs.existsSync(RESULTS_DIR)) {
        fs.readdirSync(RESULTS_DIR).forEach(rf => {
          if (!rf.endsWith(".json")) return;
          try {
            const r = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, rf), "utf-8"));
            if (r.testId === testId) {
              safeUnlink(path.join(RESULTS_DIR, rf));
              safeUnlink(path.join(RESULTS_DIR, rf.replace(".json", ".xlsx")));
            }
          } catch {}
        });
      }

      // test json
      safeUnlink(p);
      count++;
    } catch {}
  });

  res.json({ ok: true, deleted: count });
});

// 📋 O‘qituvchining testlari (tartib: eng oxirgisi tepada)
app.get("/api/teacher/tests", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");
  if (!fs.existsSync(TESTS_DIR)) return res.json([]);

  const files = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith(".json"));

  const tests = files.map(f => {
    try {
      const full = path.join(TESTS_DIR, f);
      const raw  = fs.readFileSync(full, "utf-8");
      if (!raw.trim()) throw new Error("Bo'sh fayl");
      const data = JSON.parse(raw);
      const id   = f.split("_")[1].split(".")[0];
      const stat = fs.statSync(full);

      return {
        id,
        title: data.testTitle,
        link: `/test/${id}`,
        createdAt: data.createdAt ?? stat.mtimeMs,   // vaqt
        createdBy: { email: data.createdBy?.email || "" }
      };
    } catch (err) { return null; }
  }).filter(Boolean);

  const userEmail = req.user.emails?.[0]?.value || req.user.email;

  const mine = tests
    .filter(t => t.createdBy?.email === userEmail)
    .sort((a, b) => b.createdAt - a.createdAt);      // eng oxirgi tepada

  res.json(mine);
});

// 🧪 Default test (demo)
app.get("/api/questions", (req, res) => {
  try {
    const text = fs.readFileSync(path.join(__dirname, "../data/questions.txt"), "utf-8");
    const allQuestions = parser.parseQuestions(text);
    const shuffled = allQuestions.sort(() => 0.5 - Math.random()).slice(0, 25);

    res.json({
      questions: shuffled,
      time: 1200,
      testTitle: "Python bo‘yicha oraliq nazorat",
      testType: "1-modul",
      testImage: "/images/python.png"
    });
  } catch (err) {
    console.error("❌ Savollarni o‘qishda xatolik:", err);
    res.status(500).send("Savollarni yuklab bo‘lmadi.");
  }
});
// HTTPS orqasida cookie uchun foydali
app.set('trust proxy', 1);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server ishga tushdi: http://0.0.0.0:${PORT}`);
});
