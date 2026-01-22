"use client";
import { useEffect, useState, useRef } from "react";
import { getSocket } from "@/lib/socket";

type Message = {
  snowflake: number;
  userId?: string;
  username: string;
  content: string;
  createdAt: string;
};


export default function ChatBox() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [user, setUser] = useState<any>(null);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const socket = getSocket();

  // load logged-in user
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) setUser(JSON.parse(stored));
  }, []);

  // load chat history
  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/messages`)
      .then((res) => res.json())
      .then(setMessages);
  }, []);

  // realtime messages
  useEffect(() => {
    const handler = (msg: Message) => {
      setMessages((prev) =>
  [...prev, msg].sort((a, b) => a.snowflake - b.snowflake)
);

    };

    socket.on("new-message", handler);
    return () => {
      socket.off("new-message", handler);
    };
  }, [socket]);

  // typing indicator
  useEffect(() => {
    const typingHandler = ({ username }: { username: string }) => {
      setTypingUser(username);
    };

    const stopTypingHandler = () => {
      setTypingUser(null);
    };

    socket.on("typing", typingHandler);
    socket.on("stop-typing", stopTypingHandler);

    return () => {
      socket.off("typing", typingHandler);
      socket.off("stop-typing", stopTypingHandler);
    };
  }, [socket]);

  // auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingUser]);

  const send = () => {
    if (!input.trim() || !user) return;

    socket.emit("send-message", {
      userId: user.id,
      username: user.username,
      content: input,
    });

    setInput("");
    socket.emit("stop-typing", { username: user.username });
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        maxWidth: "600px",
        margin: "auto",
        backgroundColor: "#fff",
      }}
    >
      {/* Messages container - scrollable */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "1rem",
          backgroundColor: "#f9f9f9",
        }}
      >
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "#999", paddingTop: "2rem" }}>
            No messages yet. Start the conversation!
          </div>
        ) : (
          messages.map((m, i) => {
            const isMe = m.userId === user?.id;
            const prev = messages[i - 1];
            const isSameUserAsPrev = prev && prev.userId === m.userId;
            const time = new Date(m.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });

            return (
              <div
                key={i}
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
                    wordWrap: "break-word",
                  }}
                >
                  {!isMe && !isSameUserAsPrev && (
                    <div style={{ fontSize: "12px", fontWeight: "600", marginBottom: "4px" }}>
                      {m.username}
                    </div>
                  )}
                  <div style={{ fontSize: "14px" }}>{m.content}</div>
                  <div
                    style={{
                      fontSize: "10px",
                      opacity: 0.6,
                      textAlign: "right",
                      marginTop: "4px",
                    }}
                  >
                    {time}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Typing indicator */}
        {typingUser && (
          <div style={{ fontSize: "12px", opacity: 0.6, marginBottom: "8px", fontStyle: "italic" }}>
            {typingUser} is typing...
          </div>
        )}

        {/* Auto-scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Input bar - fixed at bottom */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "1rem",
          borderTop: "1px solid #ddd",
          backgroundColor: "#fff",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            socket.emit("typing", { username: user?.username });
          }}
          onBlur={() => {
            socket.emit("stop-typing", { username: user?.username });
          }}
          onKeyPress={(e) => e.key === "Enter" && send()}
          placeholder="Type a message..."
          style={{
            flex: 1,
            padding: "0.75rem",
            border: "1px solid #ddd",
            borderRadius: "8px",
            fontSize: "14px",
          }}
        />
        <button
          onClick={send}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: "#007aff",
            color: "white",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
            fontWeight: "600",
            fontSize: "14px",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
