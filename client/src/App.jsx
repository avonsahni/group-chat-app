import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const TOKEN_KEY = "circle_token";

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setStoredToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const token = getStoredToken();
  const headers = {
    ...(options.headers || {}),
    ...(options.body && !options.headers?.["Content-Type"]
      ? { "Content-Type": "application/json" }
      : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || "Request failed" };
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || "Request failed");
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      if (mode === "register") {
        const data = await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ email, password, displayName }),
        });
        setStoredToken(data.token);
        onAuthed(data.user);
      } else {
        const data = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setStoredToken(data.token);
        onAuthed(data.user);
      }
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand brand-center">
          <span className="brand-mark" aria-hidden />
          <div>
            <div className="brand-title">Circle</div>
            <div className="brand-sub">Sign in to create groups and chat</div>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Register
          </button>
        </div>

        {error ? <div className="auth-error">{error}</div> : null}

        {mode === "register" ? (
          <label className="field">
            <span className="field-label">Display name</span>
            <input
              className="input"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        ) : null}

        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>

        {mode === "register" ? (
          <p className="auth-hint">Use at least 8 characters for your password.</p>
        ) : null}

        <button
          type="button"
          className="btn primary auth-submit"
          disabled={busy}
          onClick={submit}
        >
          {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
        </button>
      </div>
    </div>
  );
}

function MembersModal({ groupId, groupName, user, onClose, onMemberAdded }) {
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api(`/api/groups/${groupId}/members`);
    setMembers(data);
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const me = members.find((m) => m.id === user.id);
  const canInvite = groupId === "g_lobby" || me?.role === "owner";

  const addMember = async () => {
    setError("");
    setBusy(true);
    try {
      await api(`/api/groups/${groupId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setEmail("");
      await load();
      onMemberAdded?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="members-title"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal modal-wide">
        <h2 id="members-title">Members · {groupName}</h2>
        <p className="modal-hint">
          {canInvite
            ? groupId === "g_lobby"
              ? "In Lobby, any member can invite others by email. They must register first."
              : "Invite registered members by email. They must create an account first."
            : "Only the group owner can add new members."}
        </p>

        {canInvite ? (
          <div className="invite-row">
            <input
              className="input"
              placeholder="colleague@example.com"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMember()}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={addMember}
            >
              Add
            </button>
          </div>
        ) : null}

        {error ? <div className="auth-error">{error}</div> : null}

        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id} className="member-row">
              <span className="member-avatar" aria-hidden>
                {(m.displayName || "?").slice(0, 1).toUpperCase()}
              </span>
              <div className="member-meta">
                <div className="member-name">{m.displayName}</div>
                <div className="member-email">{m.email}</div>
              </div>
              <span className={`role-pill role-${m.role}`}>{m.role}</span>
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [groups, setGroups] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [status, setStatus] = useState("connecting");
  const [renameOpen, setRenameOpen] = useState(false);
  const [displayNameEdit, setDisplayNameEdit] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const listEndRef = useRef(null);
  const socketRef = useRef(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const token = getStoredToken();

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  const refreshSession = useCallback(async () => {
    const t = getStoredToken();
    if (!t) {
      setUser(null);
      setAuthChecked(true);
      return;
    }
    try {
      const data = await api("/api/auth/me");
      setUser(data.user);
    } catch {
      setStoredToken(null);
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const refreshGroups = useCallback(async () => {
    if (!user) return;
    const data = await api("/api/groups");
    setGroups(data);
    setActiveId((cur) => {
      if (cur && data.some((g) => g.id === cur)) return cur;
      return data[0]?.id ?? null;
    });
  }, [user]);

  useEffect(() => {
    if (user) refreshGroups();
  }, [user, refreshGroups]);

  useEffect(() => {
    if (!user || !token) return;

    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      auth: { token },
    });
    socketRef.current = socket;
    socket.on("connect", () => setStatus("live"));
    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", () => setStatus("auth error"));
    socket.on("message", (msg) => {
      setMessages((prev) => {
        if (msg.groupId !== activeIdRef.current) return prev;
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });
    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [user, token]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !activeId || !user) return;
    if (!s.connected) return;
    s.emit("join", { groupId: activeId });
  }, [activeId, user, status]);

  useEffect(() => {
    if (!activeId || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api(`/api/groups/${activeId}/messages`);
        if (!cancelled) {
          setMessages(data);
          scrollToBottom();
        }
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, user, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !activeId) return;
    socketRef.current?.emit("message", { groupId: activeId, text });
    setDraft("");
  }, [draft, activeId]);

  const createGroup = useCallback(async () => {
    const name = newGroupName.trim();
    if (!name) return;
    const g = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setNewGroupName("");
    await refreshGroups();
    setActiveId(g.id);
  }, [newGroupName, refreshGroups]);

  const saveDisplayName = useCallback(async () => {
    const n = displayNameEdit.trim().slice(0, 40);
    if (!n) return;
    const { user: nextUser } = await api("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ displayName: n }),
    });
    setUser(nextUser);
    setRenameOpen(false);
    if (activeId && socketRef.current?.connected) {
      socketRef.current.emit("join", { groupId: activeId });
    }
  }, [displayNameEdit, activeId]);

  const logout = useCallback(() => {
    setStoredToken(null);
    setUser(null);
    setGroups([]);
    setActiveId(null);
    setMessages([]);
    setStatus("offline");
  }, []);

  const activeGroup = groups.find((g) => g.id === activeId);

  if (!authChecked) {
    return (
      <div className="auth-screen">
        <div className="auth-card subtle">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthed={(u) => {
          setUser(u);
          setAuthChecked(true);
        }}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <div className="brand-title">Circle</div>
            <div className="brand-sub">Group chat</div>
          </div>
        </div>

        <div className="me">
          <button
            type="button"
            className="me-btn"
            onClick={() => {
              setDisplayNameEdit(user.displayName);
              setRenameOpen(true);
            }}
            title="Edit profile"
          >
            <span className="me-avatar" aria-hidden>
              {user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="me-name">{user.displayName}</span>
          </button>
          <span
            className={`pill pill-${status === "live" ? "ok" : "warn"}`}
            title="Connection"
          >
            {status === "live" ? "Live" : status}
          </span>
        </div>

        <div className="me-actions">
          <button type="button" className="btn ghost btn-small" onClick={logout}>
            Sign out
          </button>
        </div>

        <div className="new-group">
          <input
            className="input"
            placeholder="New group name…"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createGroup()}
          />
          <button type="button" className="btn primary" onClick={createGroup}>
            Create
          </button>
        </div>

        <nav className="group-list" aria-label="Groups">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`group-item ${g.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(g.id)}
            >
              <span className="group-hash">#</span>
              <span className="group-name">{g.name}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {!activeGroup ? (
          <div className="empty">
            <p>No groups yet. Create one from the sidebar.</p>
          </div>
        ) : (
          <>
            <header className="thread-head">
              <div className="thread-head-row">
                <div>
                  <h1 className="thread-title">{activeGroup.name}</h1>
                  <p className="thread-meta">
                    Signed in as {user.email} · Real-time messages
                  </p>
                </div>
                <button
                  type="button"
                  className="btn ghost members-btn"
                  onClick={() => setMembersOpen(true)}
                >
                  Members
                </button>
              </div>
            </header>

            <div className="messages" role="log" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty-thread">
                  No messages yet. Say hello below.
                </div>
              ) : (
                messages.map((m) => {
                  const mine = m.userId === user.id;
                  return (
                    <article
                      key={m.id}
                      className={`bubble-row ${mine ? "mine" : ""}`}
                    >
                      <div className="bubble">
                        {!mine && (
                          <div className="bubble-author">{m.displayName}</div>
                        )}
                        <div className="bubble-text">{m.text}</div>
                        <time
                          className="bubble-time"
                          dateTime={new Date(m.ts).toISOString()}
                        >
                          {new Date(m.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={listEndRef} />
            </div>

            <footer className="composer">
              <textarea
                className="composer-input"
                rows={1}
                placeholder={`Message #${activeGroup.name}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button type="button" className="btn primary send" onClick={send}>
                Send
              </button>
            </footer>
          </>
        )}
      </main>

      {renameOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-title"
        >
          <div className="modal">
            <h2 id="rename-title">Your display name</h2>
            <p className="modal-hint">Shown next to your messages.</p>
            <input
              className="input"
              autoFocus
              value={displayNameEdit}
              onChange={(e) => setDisplayNameEdit(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveDisplayName()}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setRenameOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={saveDisplayName}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {membersOpen && activeGroup ? (
        <MembersModal
          groupId={activeGroup.id}
          groupName={activeGroup.name}
          user={user}
          onClose={() => setMembersOpen(false)}
          onMemberAdded={refreshGroups}
        />
      ) : null}
    </div>
  );
}
