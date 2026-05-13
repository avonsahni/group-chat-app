import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const STORAGE_NAME = "circle_display_name";
const STORAGE_UID = "circle_user_id";

function randomId() {
  return "u_" + Math.random().toString(36).slice(2, 11);
}

function loadOrCreateUser() {
  let displayName = sessionStorage.getItem(STORAGE_NAME);
  if (!displayName) {
    displayName =
      "Guest-" + Math.floor(1000 + Math.random() * 9000).toString();
    sessionStorage.setItem(STORAGE_NAME, displayName);
  }
  let userId = sessionStorage.getItem(STORAGE_UID);
  if (!userId) {
    userId = randomId();
    sessionStorage.setItem(STORAGE_UID, userId);
  }
  return { displayName, userId };
}

export default function App() {
  const { displayName: initialName, userId } = useMemo(loadOrCreateUser, []);
  const [displayName, setDisplayName] = useState(initialName);
  const [groups, setGroups] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [status, setStatus] = useState("connecting");
  const [renameOpen, setRenameOpen] = useState(false);
  const listEndRef = useRef(null);
  const socketRef = useRef(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;
    socket.on("connect", () => setStatus("live"));
    socket.on("disconnect", () => setStatus("offline"));
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
    };
  }, []);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !activeId) return;
    s.emit("join", { groupId: activeId, userId, displayName });
  }, [activeId, userId, displayName]);

  const refreshGroups = useCallback(async () => {
    const res = await fetch("/api/groups");
    const data = await res.json();
    setGroups(data);
    setActiveId((cur) => {
      if (cur && data.some((g) => g.id === cur)) return cur;
      return data[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/groups/${activeId}/messages`);
      const data = await res.json();
      if (!cancelled) {
        setMessages(data);
        scrollToBottom();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, scrollToBottom]);

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
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    const g = await res.json();
    setNewGroupName("");
    await refreshGroups();
    setActiveId(g.id);
  }, [newGroupName, refreshGroups]);

  const saveDisplayName = useCallback(() => {
    const n = displayName.trim().slice(0, 40);
    if (!n) return;
    sessionStorage.setItem(STORAGE_NAME, n);
    setDisplayName(n);
    setRenameOpen(false);
    if (activeId) {
      socketRef.current?.emit("join", {
        groupId: activeId,
        userId,
        displayName: n,
      });
    }
  }, [displayName, activeId, userId]);

  const activeGroup = groups.find((g) => g.id === activeId);

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
            onClick={() => setRenameOpen(true)}
            title="Change display name"
          >
            <span className="me-avatar" aria-hidden>
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="me-name">{displayName}</span>
          </button>
          <span
            className={`pill pill-${status === "live" ? "ok" : "warn"}`}
            title="Connection"
          >
            {status === "live" ? "Live" : status}
          </span>
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
              <div>
                <h1 className="thread-title">{activeGroup.name}</h1>
                <p className="thread-meta">
                  Real-time messages · Open this URL in another tab to try
                  together
                </p>
              </div>
            </header>

            <div className="messages" role="log" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty-thread">
                  No messages yet. Say hello below.
                </div>
              ) : (
                messages.map((m) => {
                  const mine = m.userId === userId;
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
                        <time className="bubble-time" dateTime={new Date(m.ts).toISOString()}>
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
            <h2 id="rename-title">Your name</h2>
            <p className="modal-hint">Others see this next to your messages.</p>
            <input
              className="input"
              autoFocus
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
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
    </div>
  );
}
