import express from "express";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import cors from "cors";
import multer from "multer";
import { Server } from "socket.io";
import { initDatabase, getDb, newId } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  getUserFromToken,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const isProd = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3001;
/** Listen on all interfaces so phones and other machines on the LAN (or VPN) can connect. Set HOST=127.0.0.1 to bind locally only. */
const HOST = process.env.HOST || "0.0.0.0";

initDatabase(rootDir);

/**
 * CORS / Socket.io origin policy.
 * - Omit or set ALLOWED_ORIGINS=* : reflect the request Origin (works for LAN IPs and hostnames during dev).
 * - Set ALLOWED_ORIGINS=https://app.example.com,http://10.0.0.5:5173 for an explicit allowlist (recommended on the public internet).
 */
function buildCorsOrigin() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || String(raw).trim() === "*") {
    return true;
  }
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (list.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  };
}

const corsOrigin = buildCorsOrigin();

const app = express();
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

const LOBBY_ID = "g_lobby";

const MAX_UPLOAD_BYTES =
  Math.min(50, Number(process.env.MAX_UPLOAD_MB) || 12) * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]);

const uploadsDir = path.join(rootDir, "data", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 12).toLowerCase();
    cb(null, newId("f") + (ext || ""));
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("File type not allowed"));
  },
});

function safeUploadBasename(name) {
  const base = path.basename(String(name || ""));
  if (!/^f_[a-z0-9._-]+$/i.test(base)) return null;
  const resolved = path.resolve(uploadsDir, base);
  if (!resolved.startsWith(path.resolve(uploadsDir))) return null;
  return base;
}

/**
 * @param {unknown} raw
 */
function normalizeAttachments(raw) {
  if (!raw || !Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 6)) {
    if (!a || typeof a !== "object") continue;
    const id = safeUploadBasename(/** @type {any} */ (a).id);
    if (!id) continue;
    const fp = path.join(uploadsDir, id);
    if (!fp.startsWith(path.resolve(uploadsDir)) || !fs.existsSync(fp)) continue;
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      id,
      url: `/api/uploads/${id}`,
      name: String(/** @type {any} */ (a).name || id).slice(0, 200),
      mimeType: String(/** @type {any} */ (a).mimeType || "application/octet-stream").slice(
        0,
        120
      ),
      size: Number(/** @type {any} */ (a).size)) || st.size,
    });
  }
  return out;
}

function parseAttachmentsJson(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowGroup(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function isMember(userId, groupId) {
  const r = getDb()
    .prepare(
      "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
    )
    .get(groupId, userId);
  return Boolean(r);
}

function isOwner(userId, groupId) {
  const r = getDb()
    .prepare(
      `SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'owner'`
    )
    .get(groupId, userId);
  return Boolean(r);
}

function getGroup(groupId) {
  return getDb()
    .prepare("SELECT id, name, created_by, created_at FROM groups WHERE id = ?")
    .get(groupId);
}

function listMessages(groupId) {
  const rows = getDb()
    .prepare(
      `SELECT id, group_id AS groupId, user_id AS userId, display_name AS displayName, text, ts,
              attachments_json AS attachmentsJson
       FROM messages WHERE group_id = ? ORDER BY ts DESC LIMIT 500`
    )
    .all(groupId);
  return rows.reverse().map((r) => ({
    id: r.id,
    groupId: r.groupId,
    userId: r.userId,
    displayName: r.displayName,
    text: r.text,
    ts: r.ts,
    attachments: parseAttachmentsJson(r.attachmentsJson),
  }));
}

function insertMessage(msg) {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  getDb()
    .prepare(
      `INSERT INTO messages (id, group_id, user_id, display_name, text, ts, attachments_json)
       VALUES (@id, @groupId, @userId, @displayName, @text, @ts, @attachmentsJson)`
    )
    .run({
      id: msg.id,
      groupId: msg.groupId,
      userId: msg.userId,
      displayName: msg.displayName,
      text: msg.text,
      ts: msg.ts,
      attachmentsJson: JSON.stringify(attachments),
    });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", (req, res) => {
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const password = String(req.body?.password || "");
  const displayName = String(req.body?.displayName || "").trim().slice(0, 40);

  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (!displayName) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }

  const existing = getDb()
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email);
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const userId = newId("u_");
  const now = Date.now();
  const passwordHash = hashPassword(password);

  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO users (id, email, password_hash, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, email, passwordHash, displayName, now);
    getDb()
      .prepare(
        `INSERT INTO group_members (group_id, user_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`
      )
      .run(LOBBY_ID, userId, now);
  });
  tx();

  const user = {
    id: userId,
    email,
    displayName,
    createdAt: now,
  };
  res.status(201).json({ token: signToken({ id: userId, email }), user });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const row = getDb()
    .prepare(
      "SELECT id, email, password_hash AS passwordHash, display_name AS displayName, created_at AS createdAt FROM users WHERE email = ?"
    )
    .get(email);
  if (!row || !verifyPassword(password, row.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const user = {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt,
  };
  res.json({ token: signToken({ id: row.id, email: row.email }), user });
});

app.get("/api/auth/me", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const user = token ? getUserFromToken(token) : null;
  res.json({ user: user || null });
});

app.patch("/api/auth/me", requireAuth, (req, res) => {
  const displayName = String(req.body?.displayName || "").trim().slice(0, 40);
  if (!displayName) {
    res.status(400).json({ error: "Display name is required" });
    return;
  }
  getDb()
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .run(displayName, req.user.id);
  const user = {
    ...req.user,
    displayName,
  };
  res.json({ user });
});

app.get("/api/groups", requireAuth, (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT g.id, g.name, g.created_by, g.created_at
       FROM groups g
       INNER JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ?
       ORDER BY g.created_at DESC`
    )
    .all(req.user.id);
  res.json(rows.map(rowGroup));
});

app.post("/api/groups", requireAuth, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Group name is required" });
    return;
  }
  const groupId = newId("g_");
  const now = Date.now();
  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(groupId, name, req.user.id, now);
    getDb()
      .prepare(
        `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`
      )
      .run(groupId, req.user.id, now);
  });
  tx();
  res.status(201).json(rowGroup(getGroup(groupId)));
});

app.get("/api/groups/:id/messages", requireAuth, (req, res) => {
  const groupId = req.params.id;
  if (!getGroup(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (!isMember(req.user.id, groupId)) {
    res.status(403).json({ error: "You are not a member of this group" });
    return;
  }
  res.json(listMessages(groupId));
});

app.get("/api/groups/:id/members", requireAuth, (req, res) => {
  const groupId = req.params.id;
  if (!getGroup(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (!isMember(req.user.id, groupId)) {
    res.status(403).json({ error: "You are not a member of this group" });
    return;
  }
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.email, u.display_name AS displayName, gm.role, gm.joined_at AS joinedAt
       FROM group_members gm
       INNER JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY gm.joined_at ASC`
    )
    .all(groupId);
  res.json(rows);
});

app.post("/api/groups/:id/members", requireAuth, (req, res) => {
  const groupId = req.params.id;
  if (!getGroup(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (!isMember(req.user.id, groupId)) {
    res.status(403).json({ error: "You are not in this group" });
    return;
  }
  const canInvite =
    groupId === LOBBY_ID || isOwner(req.user.id, groupId);
  if (!canInvite) {
    res.status(403).json({ error: "Only the group owner can add members" });
    return;
  }
  const email = String(req.body?.email || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid member email is required" });
    return;
  }

  const invitee = getDb()
    .prepare(
      "SELECT id, display_name AS displayName FROM users WHERE email = ?"
    )
    .get(email);
  if (!invitee) {
    res.status(404).json({
      error: "No member found with that email. They need to register first.",
    });
    return;
  }
  if (invitee.id === req.user.id) {
    res.status(400).json({ error: "You are already in this group" });
    return;
  }
  const existing = getDb()
    .prepare(
      "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
    )
    .get(groupId, invitee.id);
  if (existing) {
    res.status(409).json({ error: "That member is already in this group" });
    return;
  }

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
    )
    .run(groupId, invitee.id, now);

  res.status(201).json({
    id: invitee.id,
    email,
    displayName: invitee.displayName,
    role: "member",
    joinedAt: now,
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const t = typeof token === "string" ? token : "";
  const user = getUserFromToken(t);
  if (!user) {
    next(new Error("unauthorized"));
    return;
  }
  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;

  socket.on("join", ({ groupId }) => {
    if (!groupId || !getGroup(groupId)) {
      socket.emit("error", { message: "Invalid group" });
      return;
    }
    if (!isMember(user.id, groupId)) {
      socket.emit("error", { message: "You are not a member of this group" });
      return;
    }
    const prev = socket.data.groupId;
    if (prev && prev !== groupId) socket.leave(prev);
    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userId = user.id;
    socket.data.displayName = user.displayName;
    io.to(groupId).emit("presence", {
      type: "join",
      userId: user.id,
      displayName: user.displayName,
      ts: Date.now(),
    });
  });

  socket.on("message", ({ groupId, text }) => {
    const g = groupId && getGroup(groupId);
    if (!g || !socket.rooms.has(groupId)) {
      socket.emit("error", { message: "Join the group before sending" });
      return;
    }
    if (!isMember(user.id, groupId)) {
      socket.emit("error", { message: "Not a member of this group" });
      return;
    }
    const trimmed = String(text || "").trim().slice(0, 4000);
    if (!trimmed) return;

    const fresh = getDb()
      .prepare("SELECT display_name AS displayName FROM users WHERE id = ?")
      .get(user.id);
    const displayName = fresh?.displayName || user.displayName;

    const msg = {
      id: newId("m_"),
      groupId,
      userId: user.id,
      displayName,
      text: trimmed,
      ts: Date.now(),
    };
    insertMessage(msg);
    io.to(groupId).emit("message", msg);
  });

  socket.on("disconnecting", () => {
    const gid = socket.data.groupId;
    if (gid && socket.data.userId) {
      io.to(gid).emit("presence", {
        type: "leave",
        userId: socket.data.userId,
        displayName: socket.data.displayName,
        ts: Date.now(),
      });
    }
  });
});

if (isProd) {
  const clientDist = path.join(rootDir, "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

server.listen(PORT, HOST, () => {
  const base = HOST === "0.0.0.0" ? "<this-machine-ip>" : HOST;
  console.log(`API + WebSocket http://${HOST}:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.log(
      `Other devices: open http://${base}:${PORT} (dev UI: same host, Vite port — see npm run dev log)`
    );
  }
});
