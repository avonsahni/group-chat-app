import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { getDb } from "./db.js";

const JWT_SECRET =
  process.env.JWT_SECRET || "dev-only-secret-change-with-JWT_SECRET";

const SALT_ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/**
 * @param {{ id: string; email: string }} user
 */
export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: "14d",
  });
}

export function verifyToken(token) {
  return /** @type {{ sub: string; email: string }} */ (
    jwt.verify(token, JWT_SECRET)
  );
}

/**
 * Load user from DB after JWT verification.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  try {
    const payload = verifyToken(token);
    const row = getDb()
      .prepare(
        `SELECT id, email, display_name AS displayName, created_at AS createdAt
         FROM users WHERE id = ?`
      )
      .get(payload.sub);
    if (!row) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    req.user = row;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

/**
 * @param {string} token
 */
export function getUserFromToken(token) {
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    return getDb()
      .prepare(
        `SELECT id, email, display_name AS displayName, created_at AS createdAt
         FROM users WHERE id = ?`
      )
      .get(payload.sub);
  } catch {
    return null;
  }
}
