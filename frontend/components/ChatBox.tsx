"use client";
import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";

type Message = {
  userId: string;
  username: string;
  content: string;
  createdAt: string;
};

export default function ChatBox() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [user, setUser] = useState<any>(null);

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
      setMessages((prev) => [...prev, msg]);
    };

    socket.on("new-message", handler);
    return () => {
    socket.off("new-message", handler);
    return; 
  };
  }, [socket]);

  const send = () => {
    if (!input.trim() || !user) return;

    socket.emit("send-message", {
      userId: user.id,
      username: user.username,
      content: input,
    });

    setInput("");
  };

  return (
    <div style={{ maxWidth: 600, margin: "auto" }}>
      {messages.map((m, i) => {
        const isMe = m.userId === user?.id;
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
              marginBottom: 8,
            }}
          >
            <div
              style={{
                background: isMe ? "#007aff" : "#e5e5ea",
                color: isMe ? "#fff" : "#000",
                padding: "6px 10px",
                borderRadius: 8,
                maxWidth: "70%",
              }}
            >
              {!isMe && (
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {m.username}
                </div>
              )}
              <div>{m.content}</div>
              <div
                style={{
                  fontSize: 10,
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

      <div style={{ display: "flex", marginTop: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={send}>Send</button>
      </div>
    </div>
  );
}
