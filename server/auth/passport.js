const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// 🌍 Bazaviy URL ni ENV dan olamiz (trailing slashni olib tashlaymiz)
const RAW_BASE = process.env.BASE_URL || "https://testtayyor.fly.dev";
const BASE_URL = RAW_BASE.replace(/\/+$/, "");

// ✅ Production’da to‘g‘ridan-to‘g‘ri callback URL bo‘lsa, o‘shani ishlatamiz
const CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: CALLBACK_URL
  },
  (accessToken, refreshToken, profile, done) => {
    // access_token va refresh_token ni profile ga biriktiramiz
    profile.tokens = {
      access_token: accessToken,
      refresh_token: refreshToken
    };
    return done(null, profile);
  }
));

// 🔐 Sessionga saqlash va olish
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});
