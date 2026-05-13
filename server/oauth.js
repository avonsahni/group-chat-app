import crypto from "crypto";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import AppleStrategy from "passport-apple";
import { getDb, newId } from "./db.js";
import { hashPassword, signToken } from "./auth.js";

/**
 * @param {string} [override]
 */
export function getFrontendUrl(override) {
  const u = (override || process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/$/,
    ""
  );
  return u;
}

function defaultCallbackUrl(provider) {
  const base = getFrontendUrl();
  return `${base}/api/auth/${provider}/callback`;
}

/**
 * @param {import("express").Response} res
 * @param {string} token
 */
function redirectWithJwt(res, token) {
  const front = getFrontendUrl();
  res.redirect(`${front}/#oauth_token=${encodeURIComponent(token)}`);
}

/**
 * @param {import("express").Response} res
 * @param {string} message
 */
function redirectOAuthError(res, message) {
  const front = getFrontendUrl();
  res.redirect(`${front}/#oauth_error=${encodeURIComponent(message)}`);
}

/**
 * @param {{ provider: string; subject: string; email?: string | null; displayName?: string | null }} p
 * @param {string} lobbyId
 */
export function findOrCreateOAuthUser(p, lobbyId) {
  const db = getDb();
  const provider = String(p.provider).toLowerCase();
  const subject = String(p.subject);
  let email = (p.email || "").trim().toLowerCase().slice(0, 120);
  const rawName = (p.displayName || "").trim().slice(0, 40);
  if (!email || !email.includes("@")) {
    email = `${provider}_${subject}@oauth.circle.local`.slice(0, 120);
  }
  const displayName =
    rawName ||
    email.split("@")[0].replace(/[._+]+/g, " ").slice(0, 40) ||
    "Member";

  const linked = db
    .prepare(
      "SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?"
    )
    .get(provider, subject);
  if (linked) {
    return db
      .prepare(
        `SELECT id, email, display_name AS displayName, created_at AS createdAt
         FROM users WHERE id = ?`
      )
      .get(linked.user_id);
  }

  const existingByEmail = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email);

  const now = Date.now();
  const tx = db.transaction(() => {
    let userId;
    if (existingByEmail) {
      userId = existingByEmail.id;
      db.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).run(lobbyId, userId, now);
    } else {
      userId = newId("u_");
      const passwordHash = hashPassword(crypto.randomBytes(32).toString("hex"));
      db.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, email, passwordHash, displayName, now);
      db.prepare(
        `INSERT INTO group_members (group_id, user_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      ).run(lobbyId, userId, now);
    }
    db.prepare(
      `INSERT OR IGNORE INTO oauth_identities (provider, subject, user_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(provider, subject, userId, now);
  });
  tx();

  const row = db
    .prepare(
      `SELECT id, email, display_name AS displayName, created_at AS createdAt
       FROM oauth_identities oi
       INNER JOIN users u ON u.id = oi.user_id
       WHERE oi.provider = ? AND oi.subject = ?`
    )
    .get(provider, subject);
  return row;
}

function googleEnabled() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
}

function facebookEnabled() {
  return Boolean(
    process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET
  );
}

function appleEnabled() {
  return Boolean(
    process.env.APPLE_CLIENT_ID &&
      process.env.APPLE_TEAM_ID &&
      process.env.APPLE_KEY_ID &&
      process.env.APPLE_PRIVATE_KEY
  );
}

/**
 * @param {import("express").Express} app
 * @param {{ lobbyId: string }} opts
 */
export function registerOAuthRoutes(app, opts) {
  const { lobbyId } = opts;
  app.use(passport.initialize());

  if (googleEnabled()) {
    passport.use(
      "google",
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL:
            process.env.GOOGLE_CALLBACK_URL || defaultCallbackUrl("google"),
          scope: ["profile", "email"],
        },
        (_accessToken, _refreshToken, profile, done) => {
          const email = profile.emails?.[0]?.value || null;
          const displayName =
            profile.displayName ||
            [profile.name?.givenName, profile.name?.familyName]
              .filter(Boolean)
              .join(" ") ||
            null;
          done(null, {
            provider: "google",
            subject: profile.id,
            email,
            displayName,
          });
        }
      )
    );

    app.get(
      "/api/auth/google",
      passport.authenticate("google", { session: false, scope: ["profile", "email"] })
    );
    app.get(
      "/api/auth/google/callback",
      passport.authenticate("google", {
        session: false,
        failureRedirect: `${getFrontendUrl()}/#oauth_error=${encodeURIComponent("Google sign-in failed")}`,
      }),
      (req, res) => {
        try {
          const profile = /** @type {any} */ (req.user);
          const user = findOrCreateOAuthUser(profile, lobbyId);
          const token = signToken({ id: user.id, email: user.email });
          redirectWithJwt(res, token);
        } catch (e) {
          redirectOAuthError(
            res,
            e instanceof Error ? e.message : "Google sign-in failed"
          );
        }
      }
    );
  }

  if (facebookEnabled()) {
    passport.use(
      "facebook",
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL:
            process.env.FACEBOOK_CALLBACK_URL ||
            defaultCallbackUrl("facebook"),
          profileFields: ["id", "displayName", "email", "name"],
        },
        (_accessToken, _refreshToken, profile, done) => {
          const email = profile.emails?.[0]?.value || null;
          const displayName =
            profile.displayName ||
            [profile.name?.givenName, profile.name?.familyName]
              .filter(Boolean)
              .join(" ") ||
            null;
          done(null, {
            provider: "facebook",
            subject: profile.id,
            email,
            displayName,
          });
        }
      )
    );

    app.get(
      "/api/auth/facebook",
      passport.authenticate("facebook", {
        session: false,
        scope: ["email"],
      })
    );
    app.get(
      "/api/auth/facebook/callback",
      passport.authenticate("facebook", {
        session: false,
        failureRedirect: `${getFrontendUrl()}/#oauth_error=${encodeURIComponent("Facebook sign-in failed")}`,
      }),
      (req, res) => {
        try {
          const profile = /** @type {any} */ (req.user);
          const user = findOrCreateOAuthUser(profile, lobbyId);
          const token = signToken({ id: user.id, email: user.email });
          redirectWithJwt(res, token);
        } catch (e) {
          redirectOAuthError(
            res,
            e instanceof Error ? e.message : "Facebook sign-in failed"
          );
        }
      }
    );
  }

  if (appleEnabled()) {
    const rawKey = process.env.APPLE_PRIVATE_KEY || "";
    const privateKey = rawKey.includes("\\n")
      ? rawKey.replace(/\\n/g, "\n")
      : rawKey;

    passport.use(
      "apple",
      new AppleStrategy(
        {
          clientID: process.env.APPLE_CLIENT_ID,
          teamID: process.env.APPLE_TEAM_ID,
          keyID: process.env.APPLE_KEY_ID,
          privateKeyString: privateKey,
          callbackURL:
            process.env.APPLE_CALLBACK_URL || defaultCallbackUrl("apple"),
          passReqToCallback: false,
        },
        (_accessToken, _refreshToken, idToken, _profile, done) => {
          try {
            const parts = String(idToken || "").split(".");
            if (parts.length < 2) {
              done(new Error("Missing Apple id_token"));
              return;
            }
            const payload = JSON.parse(
              Buffer.from(parts[1], "base64url").toString("utf8")
            );
            const sub = payload.sub;
            const email = payload.email || null;
            const displayName = email
              ? String(email).split("@")[0]
              : null;
            done(null, {
              provider: "apple",
              subject: sub,
              email,
              displayName,
            });
          } catch (err) {
            done(err);
          }
        }
      )
    );

    app.get("/api/auth/apple", passport.authenticate("apple", { session: false }));
    app.post(
      "/api/auth/apple/callback",
      express.urlencoded({ extended: true }),
      passport.authenticate("apple", {
        session: false,
        failureRedirect: `${getFrontendUrl()}/#oauth_error=${encodeURIComponent("Apple sign-in failed")}`,
      }),
      (req, res) => {
        try {
          const profile = /** @type {any} */ (req.user);
          const user = findOrCreateOAuthUser(profile, lobbyId);
          const token = signToken({ id: user.id, email: user.email });
          redirectWithJwt(res, token);
        } catch (e) {
          redirectOAuthError(
            res,
            e instanceof Error ? e.message : "Apple sign-in failed"
          );
        }
      }
    );
  }
}

// passport-apple POST callback needs body parser — import express in this file only for urlencoded
import express from "express";

export function getOAuthProviderFlags() {
  return {
    google: googleEnabled(),
    facebook: facebookEnabled(),
    apple: appleEnabled(),
  };
}
