"use client";

import { useEffect, useState, useRef } from "react";
import { getSocket } from "@/lib/socket";
import Link from "next/link";
import { useAuthSocket } from "@/hooks/useAuthSocket";
import { soundFx } from "@/lib/soundFx";
import AppShell from "./AppShell";

type UserPresence = {
  userId: string;
  username: string;
  status: "online" | "offline";
};

type Reaction = {
  emoji: string;
  count: number;
  me?: boolean;
};

type Message = {
  id?: string;
  delivered?: boolean;
  snowflake: string;
  userId?: string;
  username: string;
  content: string;
  createdAt: string;
  reactions?: Reaction[];
};

const REACTION_ICONS: Record<string, React.ReactNode> = {
  like: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 1.7 8.59 7.11C8.21 7.49 8 8 8 8.53V19c0 1.1.9 2 2 2h8.43c.9 0 1.67-.6 1.9-1.47l2.25-8.2c.07-.27.08-.55.03-.82l-.78-3.63z" />
    </svg>
  ),
  heart: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  ),
  fire: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" />
    </svg>
  ),
  star: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  ),
};

const EMOJI_META: Record<string, { label: string; color: string; hoverBg: string; hoverColor: string }> = {
  like: { label: "Like", color: "#5865F2", hoverBg: "hover:bg-[#5865F2]/15", hoverColor: "hover:text-[#5865F2]" },
  heart: { label: "Love", color: "#F23F43", hoverBg: "hover:bg-[#F23F43]/15", hoverColor: "hover:text-[#F23F43]" },
  fire: { label: "Fire", color: "#FF7B00", hoverBg: "hover:bg-[#FF7B00]/15", hoverColor: "hover:text-[#FF7B00]" },
  star: { label: "Star", color: "#FEE75C", hoverBg: "hover:bg-[#FEE75C]/15", hoverColor: "hover:text-[#FEE75C]" },
};

const AVAILABLE_EMOJIS = ["like", "heart", "fire", "star"];

export default function ChatBox() {
  const socket = getSocket();
  useAuthSocket();

  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<UserPresence[]>([]);
  const [input, setInput] = useState("");
  const [user, setUser] = useState<any>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const [inputFocused, setInputFocused] = useState(false);
  const [showMembers, setShowMembers] = useState(true);

  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const oldestSnowflakeRef = useRef<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<any>(null);
  const isPrependingRef = useRef(false);

  /* ---------- load user ---------- */
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) return;
    try {
      setUser(JSON.parse(stored));
    } catch {}
  }, []);

  /* ---------- presence ---------- */
  useEffect(() => {
    const handler = (payload: any) => {
      if (Array.isArray(payload.users)) {
        setOnlineUsers(payload.users.filter((u: UserPresence) => u.status === "online"));
        return;
      }
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
      socket.off("presence:update", handler);
    };
  }, [socket]);

  /* ---------- presence heartbeat ---------- */
  useEffect(() => {
    if (!user) return;
    const announcePresence = () => {
      socket.emit("presence:online", {
        userId: user.id,
        username: user.username,
      });
    };
    announcePresence();
    socket.on("connect", announcePresence);
    const interval = setInterval(() => {
      socket.emit("presence:heartbeat");
    }, 20000);

    return () => {
      clearInterval(interval);
      socket.off("connect", announcePresence);
    };
  }, [user, socket]);

  /* ---------- initial fetch ---------- */
  useEffect(() => {
    let isMounted = true;
    async function loadInitial() {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/messages?limit=50`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!isMounted) return;

        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
          if (data.messages.length > 0) {
            oldestSnowflakeRef.current = data.messages[0].snowflake;
          }
          setHasMoreHistory(data.hasMore ?? false);
        }
      } catch (err) {
        console.error("Initial load failed", err);
      }
    }
    loadInitial();
    return () => {
      isMounted = false;
    };
  }, []);

  /* ---------- load older history on scroll ---------- */
  const loadOlderHistory = async () => {
    if (loadingHistory || !hasMoreHistory || !oldestSnowflakeRef.current) return;
    setLoadingHistory(true);
    const container = containerRef.current;
    const prevHeight = container ? container.scrollHeight : 0;

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/messages?before=${oldestSnowflakeRef.current}&limit=50`
      );
      if (!res.ok) throw new Error("History fetch failed");
      const data = await res.json();

      if (Array.isArray(data.messages) && data.messages.length > 0) {
        oldestSnowflakeRef.current = data.messages[0].snowflake;
        isPrependingRef.current = true;
        setMessages((prev) => [...data.messages, ...prev]);
        setHasMoreHistory(data.hasMore ?? false);
      } else {
        setHasMoreHistory(false);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingHistory(false);
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevHeight + container.scrollTop;
        }
      });
    }
  };

  const handleScroll = () => {
    if (loadingHistory || !hasMoreHistory) return;
    if (!containerRef.current) return;
    if (containerRef.current.scrollTop < 100) {
      loadOlderHistory();
    }
  };

  /* ---------- realtime messages ---------- */
  useEffect(() => {
    socket.on("new-message-batch", (batch: Message[]) => {
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.snowflake));
        const newMessages = batch.filter((m: Message) => !existing.has(m.snowflake));

        if (newMessages.length > 0) {
          const hasOtherUserMsg = newMessages.some((m: Message) => m.username !== user?.username);
          if (hasOtherUserMsg) {
            soundFx.playMessage();
          }
        }
        return [...prev.filter((m) => !m.snowflake.startsWith("temp-")), ...newMessages];
      });
    });

    socket.on("message:ack", ({ snowflake }: { snowflake: string }) => {
      setMessages((prev) =>
        prev.map((m) => (m.snowflake === snowflake ? { ...m, delivered: true } : m))
      );
    });

    /* ---------- realtime reactions batch update (250ms coalesced) ---------- */
    socket.on("reaction:batch_update", ({ updates }: { updates: Array<{ snowflake: string; deltas: Array<{ emoji: string; delta: number; total?: number }> }> }) => {
      setMessages((prev) => {
        const updateMap = new Map<string, Array<{ emoji: string; delta: number; total?: number }>>();
        updates.forEach((u) => updateMap.set(u.snowflake, u.deltas));

        return prev.map((msg) => {
          if (!updateMap.has(msg.snowflake)) return msg;
          const deltas = updateMap.get(msg.snowflake)!;
          const currentReactions = [...(msg.reactions || [])];

          deltas.forEach(({ emoji, total, delta }) => {
            const index = currentReactions.findIndex((r) => r.emoji === emoji);
            const nextCount = total !== undefined ? total : (currentReactions[index]?.count || 0) + delta;

            if (nextCount <= 0) {
              if (index !== -1) currentReactions.splice(index, 1);
            } else {
              if (index !== -1) {
                currentReactions[index] = { ...currentReactions[index], count: nextCount };
              } else {
                currentReactions.push({ emoji, count: nextCount, me: false });
              }
            }
          });

          return { ...msg, reactions: currentReactions };
        });
      });
    });

    return () => {
      socket.off("message:ack");
      socket.off("new-message-batch");
      socket.off("reaction:batch_update");
    };
  }, [user, socket]);

  /* ---------- typing ---------- */
  useEffect(() => {
    socket.on("typing:start", ({ userId, username }) => {
      setTypingUsers((prev) => {
        const newMap = new Map(prev);
        newMap.set(userId, username);
        return newMap;
      });
    });

    socket.on("typing:stop", (userId) => {
      setTypingUsers((prev) => {
        const newMap = new Map(prev);
        newMap.delete(userId);
        return newMap;
      });
    });

    return () => {
      socket.off("typing:start");
      socket.off("typing:stop");
    };
  }, [socket]);

  /* ---------- auto scroll ---------- */
  useEffect(() => {
    if (isPrependingRef.current) {
      isPrependingRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages.length]);

  /* ---------- typing throttle ---------- */
  const lastTypingSent = useRef(0);
  const handleTyping = () => {
    if (!socket.connected || !inputFocused) return;
    const now = Date.now();
    if (now - lastTypingSent.current > 3000) {
      socket.emit("typing:start");
      lastTypingSent.current = now;
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit("typing:stop");
    }, 1500);
  };

  /* ---------- send ---------- */
  const send = () => {
    if (!input.trim() || !user) return;
    const content = input.trim();
    const tempSnowflake = `temp-${Date.now()}`;

    const optimisticMessage: Message = {
      snowflake: tempSnowflake,
      userId: user.id,
      username: user.username,
      content,
      createdAt: new Date().toISOString(),
      delivered: false,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setInput("");
    socket.emit("typing:stop");

    socket.emit(
      "send-message",
      {
        userId: user.id,
        username: user.username,
        content,
      },
      (ack: any) => {
        if (ack?.ok && ack.snowflake) {
          setMessages((prev) =>
            prev.map((m) =>
              m.snowflake === tempSnowflake
                ? { ...m, snowflake: ack.snowflake, delivered: true }
                : m
            )
          );
        }
      }
    );
  };
  const handleToggleReaction = (snowflake: string, emoji: string) => {
    if (!user || snowflake.startsWith("temp-")) return;

    // 1. Instant optimistic update
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.snowflake !== snowflake) return msg;
        const currentReactions = [...(msg.reactions || [])];
        const existingIdx = currentReactions.findIndex((r) => r.emoji === emoji);

        if (existingIdx !== -1) {
          const current = currentReactions[existingIdx];
          const isCurrentlyMe = !!current.me;
          const newCount = isCurrentlyMe ? current.count - 1 : current.count + 1;
          const newMe = !isCurrentlyMe;

          if (newCount <= 0) {
            currentReactions.splice(existingIdx, 1);
          } else {
            currentReactions[existingIdx] = {
              ...current,
              count: newCount,
              me: newMe,
            };
          }
        } else {
          currentReactions.push({ emoji, count: 1, me: true });
        }

        return { ...msg, reactions: currentReactions };
      })
    );

    // 2. Play subtle chime
    soundFx.playPop();

    // 3. Emit reaction to server
    socket.emit(
      "message:react",
      { snowflake, channelId: "global-chat", emoji },
      (ack: any) => {
        if (!ack?.ok) {
          console.error("Reaction failed:", ack?.error);
        }
      }
    );
  };

  const getAvatarColor = (name: string) => {
    if (!name) return "#5865F2";
    const colors = ["#5865F2", "#23A55A", "#F0B232", "#F23F43", "#9B59B6", "#1ABC9C"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  const formatTimestamp = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return isToday ? `Today at ${time}` : `${date.toLocaleDateString()} ${time}`;
  };

  return (
    <AppShell activeChannel="general-chat" onlineCount={onlineUsers.length}>
      <div className="flex h-full w-full overflow-hidden bg-[#171922] font-sans">
        {/* ================= CHAT STREAM COLUMN ================= */}
        <div className="flex-1 flex flex-col h-full min-w-0 bg-[#171922]">
          {/* TOP CHANNEL HEADER */}
          <header className="h-12 px-4 border-b border-white/[0.05] bg-[#171922] flex items-center justify-between shrink-0 z-10">
            <div className="flex items-center gap-2 truncate">
              <svg className="w-4 h-4 text-[#6D737F] fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
              </svg>
              <h2 className="font-semibold text-sm text-white tracking-tight">general-chat</h2>
              <div className="h-4 w-[1px] bg-white/[0.08] mx-2 hidden sm:block" />
              <span className="text-xs text-[#949BA4] truncate hidden sm:block font-mono">
                Realtime Stream
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/voice"
                className="flex items-center gap-1.5 px-3 py-1 bg-[#23A55A]/15 hover:bg-[#23A55A]/25 text-[#23A55A] border border-[#23A55A]/30 rounded-md text-xs font-semibold transition"
              >
                <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
                <span>Voice Stage</span>
              </Link>

              <button
                onClick={() => setShowMembers(!showMembers)}
                title="Toggle Member List"
                className={`p-1.5 rounded transition cursor-pointer ${
                  showMembers
                    ? "text-white bg-white/[0.08]"
                    : "text-[#949BA4] hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              </button>
            </div>
          </header>

          {/* MESSAGES STREAM */}
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 py-4 space-y-1 select-text"
          >
            {/* Start of history marker */}
            {!hasMoreHistory && (
              <div className="pt-6 pb-4 px-2">
                <div className="w-10 h-10 rounded-lg bg-[#1E212D] border border-white/[0.08] flex items-center justify-center text-sm mb-3 text-white">
                  <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Welcome to #general-chat
                </h3>
                <p className="text-xs text-[#949BA4] mt-0.5 font-mono">
                  Beginning of message stream history.
                </p>
                <div className="h-[1px] bg-white/[0.05] mt-4 mb-2" />
              </div>
            )}

            {loadingHistory && (
              <div className="text-center text-xs text-[#5865F2] font-mono py-2">
                Loading older messages…
              </div>
            )}

            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const isMe = m.userId === user?.id || m.username === user?.username;
              const isSameUser = prev && prev.username === m.username;
              const isRecentTime =
                prev &&
                Math.abs(new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 300000;
              const isClustered = isSameUser && isRecentTime;

              return (
                <div
                  key={m.snowflake}
                  className={`group relative flex items-start gap-3 px-2 py-1 rounded hover:bg-white/[0.02] transition-colors ${
                    isClustered ? "mt-0" : "mt-2"
                  }`}
                >
                  {/* Left Column: Avatar or Hover Timestamp */}
                  {!isClustered ? (
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5 shadow-sm"
                      style={{ backgroundColor: getAvatarColor(m.username) }}
                    >
                      {m.username.charAt(0).toUpperCase()}
                    </div>
                  ) : (
                    <div className="w-9 shrink-0 text-right text-[10px] text-[#6D737F] opacity-0 group-hover:opacity-100 font-mono select-none pt-0.5">
                      {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  )}

                  {/* Message Content */}
                  <div className="flex-1 min-w-0">
                    {!isClustered && (
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[13px] font-semibold tracking-tight ${isMe ? "text-[#5865F2]" : "text-[#F2F3F5]"}`}>
                          {m.username}
                        </span>
                        <span className="text-[10px] text-[#6D737F] font-mono">
                          {formatTimestamp(m.createdAt)}
                        </span>
                        {m.snowflake.startsWith("temp-") && (
                          <span className="text-[9px] text-[#F0B232] font-mono">sending…</span>
                        )}
                      </div>
                    )}

                    <div className="text-[13px] text-[#DBDEE1] leading-[19px] whitespace-pre-wrap break-words">
                      {m.content}
                    </div>

                    {/* Reaction Badges */}
                    {m.reactions && m.reactions.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {m.reactions.map((r) => {
                          const meta = EMOJI_META[r.emoji];
                          return (
                            <button
                              key={r.emoji}
                              onClick={() => handleToggleReaction(m.snowflake, r.emoji)}
                              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 cursor-pointer border ${
                                r.me
                                  ? "bg-[#5865F2]/20 border-[#5865F2]/50 text-white shadow-sm"
                                  : "bg-[#1E212D] border-white/[0.06] text-[#949BA4] hover:border-white/[0.18] hover:text-white"
                              }`}
                            >
                              <span style={{ color: r.me ? meta?.color : undefined }} className="shrink-0 flex items-center">
                                {REACTION_ICONS[r.emoji]}
                              </span>
                              <span className="font-semibold text-[11px]">{r.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Hover Quick Action Toolbar */}
                  <div className="absolute right-3 -top-3.5 hidden group-hover:flex items-center bg-[#1E212D]/95 border border-white/[0.1] rounded-lg shadow-2xl px-1 py-0.5 z-10 gap-0.5 backdrop-blur-md">
                    {AVAILABLE_EMOJIS.map((emoji) => {
                      const meta = EMOJI_META[emoji];
                      return (
                        <div key={emoji} className="relative group/btn">
                          <button
                            onClick={() => handleToggleReaction(m.snowflake, emoji)}
                            className={`p-1.5 rounded-md text-[#949BA4] ${meta.hoverColor} ${meta.hoverBg} hover:scale-125 transition-all duration-150 cursor-pointer flex items-center justify-center`}
                          >
                            {REACTION_ICONS[emoji]}
                          </button>
                          {/* Sleek Dark Tooltip */}
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 bg-[#0E0F14] border border-white/[0.12] rounded text-[10px] font-medium text-white tracking-wide whitespace-nowrap opacity-0 group-hover/btn:opacity-100 pointer-events-none transition-opacity duration-150 shadow-lg">
                            {meta.label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Typing Indicator */}
            {typingUsers.size > 0 && (
              <div className="px-2 py-1 text-xs text-[#949BA4] font-mono flex items-center gap-2">
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 bg-[#5865F2] rounded-full animate-pulse" />
                  <div className="w-1.5 h-1.5 bg-[#5865F2] rounded-full animate-pulse delay-100" />
                  <div className="w-1.5 h-1.5 bg-[#5865F2] rounded-full animate-pulse delay-200" />
                </div>
                <span>
                  {Array.from(typingUsers.values()).slice(0, 3).join(", ")} is typing…
                </span>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* CHAT INPUT AREA */}
          <div className="px-4 pb-4 pt-1 bg-[#171922]">
            <div className="relative flex items-center bg-[#1E212D] border border-white/[0.06] focus-within:border-white/[0.18] rounded-lg px-4 py-2.5 transition">
              <input
                value={input}
                onFocus={() => setInputFocused(true)}
                onBlur={() => {
                  setInputFocused(false);
                  socket.emit("typing:stop");
                }}
                onChange={(e) => {
                  setInput(e.target.value);
                  handleTyping();
                }}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Message #general-chat"
                className="w-full bg-transparent text-sm text-[#F2F3F5] placeholder-[#6D737F] outline-none font-medium"
              />
              <button
                onClick={send}
                disabled={!input.trim()}
                className="ml-2 px-3 py-1 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded transition cursor-pointer"
              >
                Send
              </button>
            </div>
          </div>
        </div>

        {/* ================= COLUMN 4: MEMBER DRAWER (240px) ================= */}
        {showMembers && (
          <aside className="w-60 bg-[#12141A] border-l border-white/[0.04] p-3 overflow-y-auto shrink-0 hidden lg:flex flex-col">
            <div className="text-[11px] font-semibold text-[#6D737F] uppercase tracking-wider px-2 py-1 mb-1">
              Online — {onlineUsers.length}
            </div>

            <div className="space-y-0.5">
              {onlineUsers.map((u) => (
                <div
                  key={u.userId}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-white/[0.04] transition cursor-pointer"
                >
                  <div className="relative">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                      style={{ backgroundColor: getAvatarColor(u.username) }}
                    >
                      {u.username.charAt(0).toUpperCase()}
                    </div>
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#23A55A] border-2 border-[#12141A]" />
                  </div>
                  <div className="truncate flex-1">
                    <div className="text-xs font-medium text-[#DBDEE1] truncate">
                      {u.username}
                      {u.userId === user?.id && (
                        <span className="ml-1 text-[10px] text-[#6D737F]">(you)</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </AppShell>
  );
}