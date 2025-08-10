const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// 🌍 Bazaviy URL ni ENV dan olamiz
const BASE_URL = process.env.BASE_URL || "https://testtayyor.fly.dev/";

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${BASE_URL}/auth/google/callback`
},
(accessToken, refreshToken, profile, done) => {
  // ✅ access_token va refresh_token ni profile ga biriktiramiz
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


