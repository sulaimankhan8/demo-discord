"use client";
import { useEffect, useState, useRef } from "react";
import { getSocket } from "@/lib/socket";

type UserPresence = {
  userId: string;
  username: string;
  status: "online" | "offline";
};

type Message = {
  id?: string;
  snowflake: string;
  userId?: string;
  username: string;
  content: string;
  createdAt: string;
  // reactions?: Record<number, number>;
};

const EMOJIS = [
  { code: 29, label: "😆" },
  { code: 42, label: "❤️" },
  { code: 17, label: "🔥" },
];

export default function ChatBox() {
  const socket = getSocket();

  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<UserPresence[]>([]);
  const [input, setInput] = useState("");
  const [user, setUser] = useState<any>(null);
  const [typingUser, setTypingUser] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<any>(null);

  /* ---------- load user ---------- */
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) return;

    const u = JSON.parse(stored);
    setUser(u);

    socket.emit("presence:online", {
      userId: u.id,
      username: u.username, // ✅ IMPORTANT
    });
  }, []);

  /* ---------- presence ---------- */
   useEffect(() => {
  const handler = (payload: any) => {
    // initial full list
    if (Array.isArray(payload.users)) {
      setOnlineUsers(
        payload.users.filter((u: UserPresence) => u.status === "online")
      );
      return;
    }

    // delta update
    const u = payload as UserPresence;

    setOnlineUsers((prev) => {
      const map = new Map(prev.map((p) => [p.userId, p]));

      if (u.status === "online") {
        map.set(u.userId, u);
      } else {
        map.delete(u.userId);
      }

      return Array.from(map.values());
    });
  };

  socket.on("presence:update", handler);

  return () => {
    socket.off("presence:update", handler); // ✅ returns void
  };
}, []);


  /* ---------- load history ---------- */
  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/messages`)
      .then((res) => res.json())
      .then(setMessages);
  }, []);

  /* ---------- realtime messages ---------- */
   useEffect(() => {
    socket.on("new-message", (msg: Message) => {
      setMessages((prev) => {
        if (prev.find((m) => m.snowflake === msg.snowflake)) return prev;

        const next = [...prev, msg];
        next.sort((a, b) =>
          BigInt(a.snowflake) > BigInt(b.snowflake) ? 1 : -1
        );
        return next;
      });
    });

    socket.on("message:ack", ({ id, snowflake }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.snowflake === snowflake ? { ...m, id } : m
        )
      );
    });

    /*socket.on("reaction:update", ({ messageId, emojiCode, delta }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                reactions: {
                  ...(m.reactions ?? {}),
                  [emojiCode]: Math.max(
                    0,
                    (m.reactions?.[emojiCode] ?? 0) + delta
                  ),
                },
              }
            : m
        )
      );
    });*/

      return () => {
      socket.off("new-message");
      socket.off("message:ack");
    };
  }, []);

  /* ---------- typing ---------- */
  useEffect(() => {
    socket.on("typing:start", ({ username }) => setTypingUser(username));
    socket.on("typing:stop", () => setTypingUser(null));

    return () => {
      socket.off("typing:start");
      socket.off("typing:stop");
    };
  }, []);

  /* ---------- auto scroll ---------- */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingUser]);

  /* ---------- typing debounce ---------- */
  const handleTyping = () => {
    socket.emit("typing:start");
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit("typing:stop");
    }, 1200);
  };

  /* ---------- send ---------- */
  const send = () => {
    if (!input.trim() || !user) return;

    socket.emit("send-message", {
      userId: user.id,
      username: user.username,
      content: input,
    });

    setInput("");
    socket.emit("typing:stop");
  };

  /* ================== UI ================== */

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      {/* ================= LEFT — ONLINE USERS ================= */}
      <div
        style={{
          width: "220px",
          height: "100vh",
          borderRight: "1px solid #ddd",
          padding: "1rem",
          background: "#f4f4f4",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "0.75rem" }}>
          Online Users
        </div>

        {onlineUsers.map((u) => (
          <div
            key={u.userId}
            style={{
              fontSize: "14px",
              padding: "6px 0",
              color: "#007aff",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            ● {u.username}
          </div>
        ))}
      </div>

      {/* ================= RIGHT — CHAT ================= */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          maxWidth: "600px",
          margin: "0 auto",
        }}
      >
        {/* -------- Messages (scrollable) -------- */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "1rem",
            backgroundColor: "#f9f9f9",
          }}
        >
          {messages.map((m, i) => {
            const isMe = m.userId === user?.id;
            const prev = messages[i - 1];
            const isSameUserAsPrev = prev && prev.userId === m.userId;

            const time = new Date(m.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });

            return (
              <div
                key={m.snowflake}
                style={{
                  display: "flex",
                  justifyContent: isMe ? "flex-end" : "flex-start",
                  marginBottom: isSameUserAsPrev ? "2px" : "8px",
                }}
              >
                <div
                  style={{
                    background: isMe ? "#007aff" : "#e5e5ea",
                    color: isMe ? "#fff" : "#000",
                    padding: "6px 10px",
                    borderRadius: "8px",
                    maxWidth: "70%",
                  }}
                >
                  {!isMe && !isSameUserAsPrev && (
                    <div style={{ fontSize: "12px", fontWeight: 600 }}>
                      {m.username}
                    </div>
                  )}

                  <div style={{ fontSize: "14px" }}>{m.content}</div>

                  {/* reactions 
                <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                  {EMOJIS.map((e) => (
                    <button
                      key={e.code}
                      disabled={!m.id}
                      onClick={() =>
                        socket.emit("reaction:add", {
                          messageId: m.id,
                          emojiCode: e.code,
                          userId: user.id,
                        })
                      }
                      style={{
                        fontSize: "11px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        opacity: m.id ? 1 : 0.4,
                      }}
                    >
                      {e.label} {m.reactions?.[e.code] ?? 0}
                    </button>
                  ))}
                </div>*/}

                  <div
                    style={{
                      fontSize: "10px",
                      opacity: 0.6,
                      textAlign: "right",
                    }}
                  >
                    {time}
                  </div>
                </div>
              </div>
            );
          })}

          {typingUser && (
            <div
              style={{
                fontSize: "12px",
                opacity: 0.6,
                fontStyle: "italic",
                marginTop: "6px",
              }}
            >
              {typingUser} is typing…
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* -------- Input (fixed bottom) -------- */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            padding: "1rem",
            borderTop: "1px solid #ddd",
            background: "#fff",
          }}
        >
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              handleTyping();
            }}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Type a message..."
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "1px solid #ddd",
              borderRadius: "8px",
            }}
          />
          <button
            onClick={send}
            style={{
              padding: "0.75rem 1.5rem",
              backgroundColor: "#007aff",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );

}
