const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

passport.use(new GoogleStrategy({
  clientID: "170161856775-8cr820keuhqni4917pjf8839ep2ur1me.apps.googleusercontent.com",
  clientSecret: "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",
  callbackURL: "/auth/google/callback"
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

