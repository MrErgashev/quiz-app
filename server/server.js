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
// 🔧 Supabase/Render TLS: self-signed sertifikatni inkor qilish
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

require("./auth/passport");

// ⬇️ Supabase client
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "tests";
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }})
  : null;

if (!supabase) {
  console.warn("⚠️ Supabase ENV topilmadi. Local faylga yozish rejimi ishlatiladi (production uchun tavsiya etilmaydi).");
}

/* =========================
   SESSION STORE qo‘shish
   Postgres pool — configlar yoniga
========================= */
const { Pool } = require("pg");
const PGSession = require("connect-pg-simple")(session);

// Render/Supabase uchun tavsiya: Transaction pooler URI (port 6543) ni qo‘ying.
// SUPABASE_DB_URL bo‘lmasa, DATABASE_URL ni o‘qiydi.
// ❗️ SSL/sertifikat xatosini oldini olish uchun kerakli query paramlarni majburan qo‘shamiz.
const RAW_DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";

// URL'ga query qo‘shuvchi kichik helper
function addParam(url, key, value) {
  if (!url) return url;
  const hasQ = url.includes("?");
  return `${url}${hasQ ? "&" : "?"}${key}=${value}`;
}

let DATABASE_URL = RAW_DB_URL;
if (DATABASE_URL) {
  // Pooler bo‘lsa (6543), pgbouncer=true bo‘lsin
  if (DATABASE_URL.includes("pooler.supabase.com:6543") && !/pgbouncer=true/i.test(DATABASE_URL)) {
    DATABASE_URL = addParam(DATABASE_URL, "pgbouncer", "true");
  }
  // sslmode berilmagan bo‘lsa — no-verify (self-signed cert chain xatosini bossa)
  if (!/sslmode=/i.test(DATABASE_URL)) {
    DATABASE_URL = addParam(DATABASE_URL, "sslmode", "no-verify");
  }
}

const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Supabase SSL talab qiladi; sertifikatni tekshirishni o‘chirib qo‘yamiz
      ssl: { require: true, rejectUnauthorized: false },
      max: +(process.env.PG_MAX || 5),
      idleTimeoutMillis: +(process.env.PG_IDLE_TIMEOUT || 30000),
      connectionTimeoutMillis: +(process.env.PG_CONN_TIMEOUT || 10000),
    })
  : null;

// (ixtiyoriy) Ulanishni sinab ko‘rib log chiqaramiz
if (pgPool) {
  pgPool.connect()
    .then(c => c.release())
    .catch(err => console.error("❌ Postgres ulanish xatosi:", err.message));
}

const app = express();
const PORT = process.env.PORT || 3000; // ⬅️ FLY.IO uchun PORT muhit o'zgaruvchisi

// --- Helpers ---
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const safeUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} };

// Urinishlar cheklovi (bitta device uchun) — HOZIRCHA FOYDLANILMAYDI
const MAX_ATTEMPTS_PER_DEVICE = 1; // xohlasangiz 2 qiling (hozir /api/save-result da ishlatilmaydi)

/**
 * MUHIM: Doimiy saqlash uchun Fly Volumes (/data) dan foydalanamiz.
 * Local dev: ./data; Production (Fly): /data  (FLY_APP_NAME mavjud bo'ladi)
 */
const BASE_DATA_DIR =
  process.env.DATA_DIR || (process.env.FLY_APP_NAME ? "/data" : path.join(__dirname, "../data"));

const DATA_DIR = BASE_DATA_DIR;
const TESTS_DIR = path.join(DATA_DIR, "tests");
const RESULTS_DIR = path.join(DATA_DIR, "results");

// Upload rasmlarini ham doimiy saqlaymiz (URL /uploads/... o'zgarmaydi)
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads");

ensureDir(DATA_DIR); ensureDir(TESTS_DIR); ensureDir(RESULTS_DIR); ensureDir(UPLOADS_DIR);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   trust proxy ni sessiondan OLDIN qo‘ying
========================= */
app.set("trust proxy", 1);

/* =========================
   Session middleware (PG store + fallback MemoryStore)
   — MUSTAHKAM VARIANT
========================= */
const SESSION_SECRET = process.env.SESSION_SECRET || "super-secret-key";
// Render’da vaqtincha memory store ishlatish uchun (ixtiyoriy)
const FORCE_MEMORY_SESSION = process.env.FORCE_MEMORY_SESSION === "1";
const MemoryStore = session.MemoryStore;
const isProd =
  process.env.NODE_ENV === "production" ||
  !!process.env.RENDER ||
  !!process.env.FLY_APP_NAME;

let sessionStore;
if (!FORCE_MEMORY_SESSION && pgPool) {
  sessionStore = new PGSession({
    pool: pgPool,
    tableName: "user_sessions",
    createTableIfMissing: true,
    // pruneSessionInterval: 60 * 60, // ixtiyoriy
  });
} else {
  console.warn("⚠️ PG session o‘rniga MemoryStore ishlayapti (FORCE_MEMORY_SESSION yoki PG mavjud emas).");
  sessionStore = new MemoryStore();
}

const sessionOptions = {
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // ⬇️ Render/NGINX proxy orqasida secure cookie to‘g‘ri ishlashi uchun
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: !!isProd,              // prod-da true, local dev-da false
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 kun
  }
};
app.use(session(sessionOptions));

app.use(passport.initialize());
app.use(passport.session());

// public/ (statik) fayllar
app.use(express.static(path.join(__dirname, "../public")));

// /uploads URL'ini doimiy diskdan servis qilamiz (Supabase bo'lsa ham multer temp uchun ishlatiladi)
app.use("/uploads", express.static(UPLOADS_DIR));

// ⬇️ Multer temporar papkani doimiy UPLOADS_DIR ga yo'naltirdik
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

// *** ESKI CALLBACK ROUTE O‘RNIGA — KUCHLI XATO-HANDLERLI VARIANT ***
app.get("/auth/google/callback", (req, res, next) => {
  passport.authenticate("google", (err, user, info) => {
    if (err) {
      console.error("❌ OAuth callback error:", err);
      return res.status(500).send("OAuth xatosi: " + (err.message || "Noma'lum xato"));
    }
    if (!user) {
      console.warn("⚠️ OAuth foydalanuvchi qaytmadi:", info);
      return res.redirect("/");
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error("❌ Session saqlash (req.logIn) xatosi:", loginErr);
        return res
          .status(500)
          .send("Sessiyani saqlashda xatolik: " + (loginErr.message || "Noma'lum xato"));
      }
      return res.redirect("/dashboard.html");
    });
  })(req, res, next);
});

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

      // ⬇️ Vaqtni (duration) cheksiz qo'llab-quvvatlash
      const normalizeTime = (val) => {
        if (val === undefined || val === null) return null;
        if (val === "" || val === "null") return null;
        const n = parseInt(val, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const timeVal = normalizeTime(duration);

      // 3) Rasmni Supabase Storage'ga yoki localga saqlash
      const id = crypto.randomBytes(5).toString("hex");
      let imagePath = null;     // local URL (agar Supabase bo'lmasa)
      let imageUrl = null;      // Supabase public URL (agar Supabase bo'lsa)

      if (imageFile) {
        const ext = path.extname(imageFile.originalname) || ".jpg";
        if (supabase) {
          // Supabase Storage
          const storagePath = `images/${id}${ext}`;
          const fileBuffer = fs.readFileSync(imageFile.path);
          const { error: upErr } = await supabase
            .storage
            .from(SUPABASE_BUCKET)
            .upload(storagePath, fileBuffer, {
              contentType: imageFile.mimetype || "image/jpeg",
              upsert: true
            });
          if (upErr) {
            console.warn("Storage upload error:", upErr.message, "→ Localga saqlanyapti.");
          } else {
            const { data: pub } = supabase
              .storage
              .from(SUPABASE_BUCKET)
              .getPublicUrl(storagePath);
            imageUrl = pub?.publicUrl || null;
          }
          // tempni tozalash
          safeUnlink(imageFile.path);
        } else {
          // Local uploads (fallback)
          const newName = `${id}${ext}`;
          fs.renameSync(imageFile.path, path.join(UPLOADS_DIR, newName));
          imagePath = `/uploads/${newName}`;
        }
      }

      // 4) Testni saqlash
      const userEmail = user.emails?.[0]?.value || user.email;

      if (supabase) {
        // DB: tests jadvaliga INSERT
        const { error: insErr } = await supabase.from("tests").insert({
          test_id: id,
          title: testName,
          test_type: "Yangi yuklangan test",
          time_minutes: timeVal,           // daqiqa yoki null
          question_count: desired,
          image_url: imageUrl,             // public URL
          all_questions: allQuestions,     // JSONB
          created_by_email: userEmail,
          created_by_name: user.displayName
        });
        if (insErr) {
          console.error("DB insert error:", insErr.message);
          return res.status(500).json({ error: "DB saqlashda xatolik" });
        }
      } else {
        // LOCAL: JSON faylga yozish (fallback)
        const saveJsonPath = path.join(TESTS_DIR, `test_${id}.json`);
        fs.writeFileSync(
          saveJsonPath,
          JSON.stringify(
            {
              testTitle: testName,
              testType: "Yangi yuklangan test",
              time: timeVal,                // daqiqa yoki null (cheksiz)
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
      }

      // 5) .txt faylni Google Drive’ga yuklash (best-effort)
      try {
        const drive = getDriveClient(user.tokens || {});
        await drive.files.create({
          requestBody: { name: `${testName}_${Date.now()}.txt`, parents: ['root'] },
          media: { mimeType: "text/plain", body: fs.createReadStream(file.path) }
        });
      } catch (e) {
        console.warn("Drive yuklash ogohlantirish:", e.message);
      } finally {
        safeUnlink(file.path);
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

// 📚 AJAX test (eski) — LOCAL fallback uchun qoldirildi
app.get("/api/test/:id", (req, res) => {
  const id = req.params.id;
  const filePath = path.join(TESTS_DIR, `test_${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "❌ Test topilmadi" });

  const data = fs.readFileSync(filePath, "utf-8");
  res.json(JSON.parse(data));
});

// 🆕 Talaba uchun test ma’lumotlari — har chaqiriqda tasodifiy tanlab qaytaramiz
app.get("/api/tests/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // 🔒 Brauzer keshlamasligi uchun kuchli headerlar
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    if (supabase) {
      const { data, error } = await supabase
        .from("tests")
        .select("*")
        .eq("test_id", id)
        .single();

      if (error || !data) return res.status(404).json({ error: "❌ Test topilmadi" });

      const pool = Array.isArray(data.all_questions) ? data.all_questions : [];
      const desired = Math.max(1, Math.min(data.question_count || pool.length, pool.length));

      const shuffled = pool
        .map(v => ({ v, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .slice(0, desired)
        .map(({ v }) => v);

      return res.json({
        testName: data.title,
        testType: data.test_type || "Test",
        duration: (data.time_minutes ?? null),   // daqiqa yoki null (cheksiz)
        questionCount: shuffled.length,
        testImage: data.image_url || null,
        questions: shuffled
      });
    } else {
      // LOCAL fallback
      const filePath = path.join(TESTS_DIR, `test_${id}.json`);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "❌ Test topilmadi" });

      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      const pool = Array.isArray(data.allQuestions) && data.allQuestions.length
        ? data.allQuestions
        : (Array.isArray(data.questions) ? data.questions : []);

      const desired = Math.max(1, Math.min(data.questionCount || pool.length, pool.length));

      const shuffled = pool
        .map(v => ({ v, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .slice(0, desired)
        .map(({ v }) => v);

      return res.json({
        testName: data.testTitle,
        testType: data.testType || "Test",
        duration: (data.time ?? null),
        questionCount: shuffled.length,
        testImage: data.testImage || null,
        questions: shuffled
      });
    }
  } catch (e) {
    console.error("GET /api/tests/:id error:", e);
    res.status(500).json({ error: "Xatolik" });
  }
});

// 📊 Natijani saqlash — Supabase DB (JSON/XLSX faylga bog'liq emas)
app.post("/api/save-result", async (req, res) => {
  const result = req.body; // { testId, fullname, group, university, faculty, correct, total, score, startedAt, finishedAt, timeSpent }

  try {
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
        time_spent_seconds: result.timeSpent ?? null
      });
      if (error) {
        console.error("❌ Supabase save-result error:", error.message);
        return res.status(500).send("Xatolik");
      }

      // (ixtiyoriy) — Google Drive'ga XLSX yuborish (bufferdan)
      try {
        const toDate = (ts) => ts ? new Date(ts) : null;
        const fmtDate = (d) => !d ? "" : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
        const fmtTime = (d) => !d ? "" : `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

        const st = toDate(result.startedAt);
        const fn = toDate(result.finishedAt);
        const ws = XLSX.utils.json_to_sheet([{
          FISH: result.fullname,
          Guruh: result.group,
          Universitet: result.university,
          Yonalish: result.faculty,
          Togri: result.correct,
          Umumiy: result.total,
          Foiz: (result.score ?? 0) + "%",
          BoshlaganSana: fmtDate(st),
          BoshlaganVaqt: fmtTime(st),
          TugatganSana: fmtDate(fn),
          TugatganVaqt: fmtTime(fn),
          Vaqt_sarfi: Math.floor((result.timeSpent ?? 0)/60) + " daq " + ((result.timeSpent ?? 0)%60) + " sek"
        }]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Natija");
        const xlsBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

        if (req.isAuthenticated()) {
          try {
            const drive = getDriveClient(req.user.tokens || {});
            await drive.files.create({
              requestBody: { name: `result_${result.testId}_${Date.now()}.xlsx`, parents: ['root'] },
              media: {
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                body: Buffer.from(xlsBuffer)
              }
            });
          } catch (e) {
            console.warn("Drive ga natija yuborishda ogohlantirish:", e.message);
          }
        }
      } catch (e) {
        console.warn("XLSX yaratishda ogohlantirish:", e.message);
      }

      return res.status(200).json({ message: "✅ Natija saqlandi" });
    } else {
      // LOCAL fallback — eski faylga yozish
      const fileName = `result_${result.testId}_${Date.now()}.json`;
      const savePath = path.join(RESULTS_DIR, fileName);
      fs.writeFileSync(savePath, JSON.stringify(result, null, 2));

      // Excel yaratib (localga) va Drive'ga yuborish (eski xulq)
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

      if (req.isAuthenticated()) {
        try {
          const drive = getDriveClient(req.user.tokens || {});
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

      return res.status(200).json({ message: "✅ Natija saqlandi", fileName });
    }
  } catch (err) {
    console.error("❌ Natijani saqlashda xatolik:", err);
    res.status(500).send("Xatolik");
  }
});

// 📥 TEST STATISTIKASINI YUKLAB BERISH (o‘qituvchi uchun, umumiy xlsx)
app.get("/api/export/:id", async (req, res) => {
  const testId = req.params.id;

  try {
    if (supabase) {
      const { data: rows, error } = await supabase
        .from("results")
        .select("*")
        .eq("test_id", testId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("export select error:", error.message);
        return res.status(500).send("Xatolik");
      }
      if (!rows || rows.length === 0) return res.status(404).send("Ushbu test uchun natijalar topilmadi.");

      // Toshkent vaqti (UTC+5) bilan ko'rsatish
      const TZ_OFFSET_MIN = +(process.env.TZ_OFFSET_MINUTES || 300); // 300 = UTC+5
      const toDate = (d) => d ? new Date(d) : null;
      const toTashkent = (dt) => !dt ? null : new Date(dt.getTime() + TZ_OFFSET_MIN * 60 * 1000);
      const fmtDate = (dt) => {
        const t = toTashkent(dt);
        return !t ? "" : `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
      };
      const fmtTime = (dt) => {
        const t = toTashkent(dt);
        return !t ? "" : `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
      };

      const sheetRows = rows.map(r => {
        const st = toDate(r.started_at);
        const fn = toDate(r.finished_at);
        const spent = r.time_spent_seconds ?? 0;
        return {
          FISH: r.fullname || "",
          Guruh: r.group || "",
          Universitet: r.university || "",
          Yonalish: r.faculty || "",
          Togri: r.correct ?? 0,
          Umumiy: r.total ?? 0,
          Foiz: (r.score ?? 0) + "%",
          BoshlaganSana: fmtDate(st),
          BoshlaganVaqt: fmtTime(st),
          TugatganSana: fmtDate(fn),
          TugatganVaqt: fmtTime(fn),
          Vaqt_sarfi: Math.floor(spent/60) + " daq " + (spent%60) + " sek"
        };
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      XLSX.utils.book_append_sheet(wb, ws, "Statistika");
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="stats_${testId}.xlsx"`);
      return res.send(buffer);
    } else {
      // LOCAL fallback — eski fayllardan yig'ish
      if (!fs.existsSync(RESULTS_DIR)) return res.status(404).send("Natijalar topilmadi");
      const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith(".json"));
      const rows = [];

      // Toshkent vaqti (UTC+5) bilan ko'rsatish
      const TZ_OFFSET_MIN_LOCAL = +(process.env.TZ_OFFSET_MINUTES || 300);
      const splitDateTime = (ts) => {
        if (!ts) return { date: "", time: "" };
        const base = new Date(ts);
        const d = new Date(base.getTime() + TZ_OFFSET_MIN_LOCAL * 60 * 1000);
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
      return res.send(buffer);
    }
  } catch (e) {
    console.error("export xatolik:", e);
    res.status(500).send("Xatolik");
  }
});

// 🗑️ Bitta testni o‘chirish (faqat egasi)
app.delete("/api/tests/:id", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  const testId = req.params.id;

  try {
    if (supabase) {
      // testni topamiz
      const me = req.user.emails?.[0]?.value || req.user.email;
      const { data: row, error: e1 } = await supabase
        .from("tests").select("*").eq("test_id", testId).single();
      if (e1 || !row) return res.status(404).send("Test topilmadi");
      if (row.created_by_email !== me) return res.status(403).send("Ruxsat yo‘q");

      // storage'dan rasmni o'chirish (agar bor bo'lsa, va path'ni chiqarib olsa bo'lsa)
      if (row.image_url) {
        try {
          const marker = `/object/public/${SUPABASE_BUCKET}/`;
          const idx = row.image_url.indexOf(marker);
          if (idx >= 0) {
            const pathInBucket = row.image_url.substring(idx + marker.length);
            await supabase.storage.from(SUPABASE_BUCKET).remove([pathInBucket]);
          }
        } catch {}
      }

      // avval shu testga tegishli natijalarni o'chirish
      await supabase.from("results").delete().eq("test_id", testId);
      // so'ng testning o'zini o'chirish
      const { error: e2 } = await supabase.from("tests").delete().eq("test_id", testId);
      if (e2) return res.status(500).send("Xatolik");

      return res.json({ ok: true, message: "Test o‘chirildi" });
    } else {
      // LOCAL fallback
      const jsonPath = path.join(TESTS_DIR, `test_${testId}.json`);
      if (!fs.existsSync(jsonPath)) return res.status(404).send("Test topilmadi");

      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const ownerEmail = data?.createdBy?.email || "";
      const me = req.user.emails?.[0]?.value || req.user.email;
      if (ownerEmail !== me) return res.status(403).send("Ruxsat yo‘q");

      // Rasmni o‘chir (endi doimiy uploads dan)
      if (data.testImage && data.testImage.startsWith("/uploads/")) {
        const imgAbs = path.join(UPLOADS_DIR, path.basename(data.testImage));
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
      return res.json({ ok: true, message: "Test o‘chirildi" });
    }
  } catch (e) {
    console.error("DELETE /api/tests/:id xatolik:", e);
    res.status(500).send("Xatolik");
  }
});

// 🗑️ O‘qituvchining hamma testlarini o‘chirish (faqat o‘ziga tegishli)
app.delete("/api/tests", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  try {
    if (supabase) {
      const me = req.user.emails?.[0]?.value || req.user.email;
      const { data: tests, error } = await supabase
        .from("tests")
        .select("test_id,image_url,created_by_email")
        .eq("created_by_email", me);
      if (error) return res.status(500).json({ ok: false });

      // rasm storage tozalash
      for (const t of (tests || [])) {
        if (t.image_url) {
          try {
            const marker = `/object/public/${SUPABASE_BUCKET}/`;
            const idx = t.image_url.indexOf(marker);
            if (idx >= 0) {
              const pathInBucket = t.image_url.substring(idx + marker.length);
              await supabase.storage.from(SUPABASE_BUCKET).remove([pathInBucket]);
            }
          } catch {}
        }
        await supabase.from("results").delete().eq("test_id", t.test_id);
      }
      await supabase.from("tests").delete().eq("created_by_email", me);

      return res.json({ ok: true, deleted: (tests || []).length });
    } else {
      // LOCAL fallback (eski)
      const me = req.user.emails?.[0]?.value || req.user.email;
      if (!fs.existsSync(TESTS_DIR)) return res.json({ ok: true, deleted: 0 });

      let count = 0;

      fs.readdirSync(TESTS_DIR).forEach(f => {
        if (!f.endswith(".json")) return;
      });

      // (eski tozalash mantig‘i pastda saqlangan)
      const files = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const p = path.join(TESTS_DIR, f);
          const data = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (data?.createdBy?.email !== me) continue;

          if (data.testImage && data.testImage.startsWith("/uploads/")) {
            const imgAbs = path.join(UPLOADS_DIR, path.basename(data.testImage));
            safeUnlink(imgAbs);
          }

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

          safeUnlink(p);
          count++;
        } catch {}
      }

      return res.json({ ok: true, deleted: count });
    }
  } catch (e) {
    console.error("DELETE /api/tests xatolik:", e);
    res.status(500).json({ ok: false });
  }
});

// 📋 O‘qituvchining testlari (tartib: eng oxirgisi tepada)
app.get("/api/teacher/tests", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  try {
    if (supabase) {
      const userEmail = req.user.emails?.[0]?.value || req.user.email;
      const { data, error } = await supabase
        .from("tests")
        .select("test_id,title,created_at,created_by_email")
        .eq("created_by_email", userEmail)
        .order("created_at", { ascending: false });
      if (error) return res.json([]);

      const items = (data || []).map(row => ({
        id: row.test_id,
        title: row.title,
        link: `/test/${row.test_id}`,
        createdAt: new Date(row.created_at).getTime(),
        createdBy: { email: row.created_by_email }
      }));
      return res.json(items);
    } else {
      // LOCAL fallback — eski usul
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
            createdAt: data.createdAt ?? stat.mtimeMs,
            createdBy: { email: data.createdBy?.email || "" }
          };
        } catch (err) { return null; }
      }).filter(Boolean);

      const userEmail = req.user.emails?.[0]?.value || req.user.email;

      const mine = tests
        .filter(t => t.createdBy?.email === userEmail)
        .sort((a, b) => b.createdAt - a.createdAt);

      return res.json(mine);
    }
  } catch (e) {
    console.error("teacher/tests xatolik:", e);
    res.json([]); 
  }
});

// 🔧 Test sozlamalari: ko'rish (faqat egasi)
app.get("/api/tests/:id/settings", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  const testId = req.params.id;

  try {
    if (supabase) {
      const me = req.user.emails?.[0]?.value || req.user.email;
      const { data, error } = await supabase.from("tests").select("*").eq("test_id", testId).single();
      if (error || !data) return res.status(404).send("Test topilmadi");
      if (data.created_by_email !== me) return res.status(403).send("Ruxsat yo‘q");

      return res.json({
        testId,
        time: data.time_minutes ?? null,               // null => vaqt cheklanmagan
        questionCount: data.question_count,
        totalQuestions: Array.isArray(data.all_questions) ? data.all_questions.length : 0
      });
    } else {
      // LOCAL fallback
      const jsonPath = path.join(TESTS_DIR, `test_${testId}.json`);
      if (!fs.existsSync(jsonPath)) return res.status(404).send("Test topilmadi");

      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const ownerEmail = data?.createdBy?.email || "";
      const me = req.user.emails?.[0]?.value || req.user.email;
      if (ownerEmail !== me) return res.status(403).send("Ruxsat yo‘q");

      return res.json({
        testId,
        time: data.time ?? null,
        questionCount: data.questionCount || (Array.isArray(data.allQuestions) ? data.allQuestions.length : (Array.isArray(data.questions) ? data.questions.length : 0)),
        totalQuestions: (Array.isArray(data.allQuestions) ? data.allQuestions.length : (Array.isArray(data.questions) ? data.questions.length : 0))
      });
    }
  } catch (e) {
    console.error("GET /api/tests/:id/settings xatolik:", e);
    res.status(500).send("Xatolik");
  }
});

// 🔧 Test sozlamalari: yangilash (faqat egasi)
// Body: { time: number|null|"" , questionCount: number }
app.patch("/api/tests/:id/settings", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Tizimga kiring");

  const testId = req.params.id;

  const normalizeTime = (val) => {
    if (val === undefined) return undefined; // yuborilmagan bo'lsa o'zgartirmaymiz
    if (val === null || val === "" || val === "null") return null;
    const n = parseInt(val, 10);
    return Number.isFinite(n) && n > 0 ? n : null; // <=0 yoki NaN => cheksiz
  };

  try {
    if (supabase) {
      const me = req.user.emails?.[0]?.value || req.user.email;

      const { data: row, error: e1 } = await supabase.from("tests").select("*").eq("test_id", testId).single();
      if (e1 || !row) return res.status(404).send("Test topilmadi");
      if (row.created_by_email !== me) return res.status(403).send("Ruxsat yo‘q");

      const poolLen = Array.isArray(row.all_questions) ? row.all_questions.length : 0;

      const update = {};
      const t = normalizeTime(req.body.time);
      if (t !== undefined) update.time_minutes = t;

      if (req.body.questionCount !== undefined) {
        const q = parseInt(req.body.questionCount, 10);
        if (Number.isFinite(q)) update.question_count = Math.max(1, Math.min(q, poolLen || q));
      }

      const { error: e2 } = await supabase.from("tests").update(update).eq("test_id", testId);
      if (e2) return res.status(500).send("Xatolik");

      return res.json({
        ok: true,
        settings: {
          time: update.time_minutes ?? row.time_minutes ?? null,
          questionCount: update.question_count ?? row.question_count,
          totalQuestions: poolLen
        }
      });
    } else {
      // LOCAL fallback
      const jsonPath = path.join(TESTS_DIR, `test_${testId}.json`);
      if (!fs.existsSync(jsonPath)) return res.status(404).send("Test topilmadi");

      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const ownerEmail = data?.createdBy?.email || "";
      const me = req.user.emails?.[0]?.value || req.user.email;
      if (ownerEmail !== me) return res.status(403).send("Ruxsat yo‘q");

      const poolLen = Array.isArray(data.allQuestions) ? data.allQuestions.length
                    : Array.isArray(data.questions) ? data.questions.length
                    : 0;

      // 🕒 time (cheksiz uchun null)
      const t = normalizeTime(req.body.time);
      if (t !== undefined) {
        data.time = t; // number yoki null
      }

      // 🔢 questionCount (1..poolLen oralig'ida clamp)
      if (req.body.questionCount !== undefined) {
        const q = parseInt(req.body.questionCount, 10);
        if (Number.isFinite(q)) {
          data.questionCount = Math.max(1, Math.min(q, poolLen || q)); // pool 0 bo'lsa ham q saqlansin
        }
      }

      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
      return res.json({
        ok: true,
        settings: {
          time: data.time ?? null,
          questionCount: data.questionCount,
          totalQuestions: poolLen
        }
      });
    }
  } catch (e) {
    console.error("PATCH /api/tests/:id/settings xatolik:", e);
    res.status(500).send("Xatolik");
  }
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
// HTTPS orqasida cookie uchun foydali (oldinda ham qo‘yilgan)
app.set('trust proxy', 1);

// (Ixtiyoriy) Global error handler — kutilmagan xatolarni chiroyli ko‘rsatadi
app.use((err, req, res, next) => {
  console.error("🔥 Kutilmagan xato:", err);
  res.status(500).send(err?.message || "Internal Server Error");
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server ishga tushdi: http://0.0.0.0:${PORT}`);
});
