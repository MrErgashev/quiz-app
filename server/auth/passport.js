// auth/passport.js
require("dotenv").config();
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

/**
 * Bazaviy URL ni ENV dan olamiz va trailing slashni olib tashlaymiz.
 * Productionda Render ortida ishlaganda HTTPS ni majburlash uchun proxy:true ishlatiladi.
 */
const isProd = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

// Agar BASE_URL berilmasa, productionda Render domeni, lokalda esa localhost deb olamiz
const RAW_BASE =
  process.env.BASE_URL ||
  (isProd ? "https://testtayyor.onrender.com" : "http://localhost:3000");

// Slashlarni tozalaymiz
const BASE_URL = (RAW_BASE || "").replace(/\/+$/, "");

// Callback URL: agar GOOGLE_CALLBACK_URL berilgan bo‘lsa o‘sha, aks holda BASE_URL + /auth/google/callback
const CALLBACK_URL = (
  process.env.GOOGLE_CALLBACK_URL ||
  `${BASE_URL}/auth/google/callback`
).replace(/\/+$/, ""); // oxiridagi / bo‘lsa ham olib tashlaymiz (Google bilan 1:1 moslik uchun)

// Foydali loglar (faqat start paytida bir marta ko‘rinadi)
console.log("[OAuth] BASE_URL:", BASE_URL);
console.log("[OAuth] CALLBACK_URL:", CALLBACK_URL);

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn("⚠️  GOOGLE_CLIENT_ID yoki GOOGLE_CLIENT_SECRET topilmadi. OAuth o‘chirildi (server ishlashda davom etadi).");
} else {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        /**
         * proxy: true — reverse proxy (Render/Heroku/Fly) ortida bo‘lganda
         * passport-oauth2 http -> https qayta yozilishini to‘g‘ri hisobga oladi.
         */
        proxy: true,
      },
      (accessToken, refreshToken, profile, done) => {
        // access_token va refresh_token ni profile ga biriktiramiz
        profile.tokens = {
          access_token: accessToken,
          refresh_token: refreshToken,
        };

        // Qo‘shimcha qulay maydonlar (ixtiyoriy)
        profile.email =
          (profile.emails && profile.emails[0] && profile.emails[0].value) || null;
        profile.photo =
          (profile.photos && profile.photos[0] && profile.photos[0].value) || null;

        return done(null, profile);
      }
    )
  );
}

// 🔐 Sessionga saqlash va olish
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

module.exports = passport;
