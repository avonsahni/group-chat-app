import express from "express";
import http from "http";
import { fileURLToPath } from "url";
import path from "path";
import cors from "cors";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const isProd = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/** @type {Map<string, { id: string; name: string; createdAt: number }>} */
const groups = new Map();
/** @type {Map<string, Array<{ id: string; groupId: string; userId: string; displayName: string; text: string; ts: number }>>} */
const messagesByGroup = new Map();

const defaultGroupId = "g_general";
groups.set(defaultGroupId, {
  id: defaultGroupId,
  name: "General",
  createdAt: Date.now(),
});
messagesByGroup.set(defaultGroupId, []);

function ensureGroup(id) {
  return groups.get(id);
}

function addMessage(groupId, msg) {
  const list = messagesByGroup.get(groupId) || [];
  list.push(msg);
  if (list.length > 500) list.splice(0, list.length - 500);
  messagesByGroup.set(groupId, list);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/groups", (_req, res) => {
  res.json([...groups.values()].sort((a, b) => b.createdAt - a.createdAt));
});

app.post("/api/groups", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!name) {
    res.status(400).json({ error: "Group name is required" });
    return;
  }
  const id =
    "g_" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36);
  const group = { id, name, createdAt: Date.now() };
  groups.set(id, group);
  messagesByGroup.set(id, []);
  res.status(201).json(group);
});

app.get("/api/groups/:id/messages", (req, res) => {
  const g = ensureGroup(req.params.id);
  if (!g) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(messagesByGroup.get(g.id) || []);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

io.on("connection", (socket) => {
  socket.on("join", ({ groupId, userId, displayName }) => {
    if (!groupId || !ensureGroup(groupId)) {
      socket.emit("error", { message: "Invalid group" });
      return;
    }
    const prev = socket.data.groupId;
    if (prev && prev !== groupId) socket.leave(prev);
    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userId = userId || socket.id;
    socket.data.displayName = String(displayName || "Someone").slice(0, 40);
    io.to(groupId).emit("presence", {
      type: "join",
      userId: socket.data.userId,
      displayName: socket.data.displayName,
      ts: Date.now(),
    });
  });

  socket.on("message", ({ groupId, text }) => {
    const g = groupId && ensureGroup(groupId);
    if (!g || !socket.rooms.has(groupId)) {
      socket.emit("error", { message: "Join the group before sending" });
      return;
    }
    const trimmed = String(text || "").trim().slice(0, 4000);
    if (!trimmed) return;
    const msg = {
      id: "m_" + Math.random().toString(36).slice(2) + Date.now().toString(36),
      groupId,
      userId: socket.data.userId,
      displayName: socket.data.displayName || "Someone",
      text: trimmed,
      ts: Date.now(),
    };
    addMessage(groupId, msg);
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

server.listen(PORT, () => {
  console.log(`API + WebSocket http://localhost:${PORT}`);
});
