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
    <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017a2 2 0 01-1.414-.586l-4.243-4.243A2 2 0 015 14.757V10a2 2 0 012-2h3.586a1 1 0 00.707-.293l2.414-2.414a2 2 0 012.828 0v0a2 2 0 01.586 1.414V10z" />
    </svg>
  ),
  heart: (
    <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  ),
  fire: (
    <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
    </svg>
  ),
  star: (
    <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  ),
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
                        {m.reactions.map((r) => (
                          <button
                            key={r.emoji}
                            onClick={() => handleToggleReaction(m.snowflake, r.emoji)}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono transition cursor-pointer border ${
                              r.me
                                ? "bg-[#5865F2]/20 border-[#5865F2]/50 text-[#5865F2]"
                                : "bg-[#1E212D] border-white/[0.06] text-[#949BA4] hover:border-white/[0.15] hover:text-white"
                            }`}
                          >
                            {REACTION_ICONS[r.emoji]}
                            <span className="font-semibold text-[11px]">{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Hover Quick Action Toolbar */}
                  <div className="absolute right-3 -top-3 hidden group-hover:flex items-center bg-[#1E212D] border border-white/[0.08] rounded shadow-lg px-1 py-0.5 z-10 transition">
                    {AVAILABLE_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => handleToggleReaction(m.snowflake, emoji)}
                        title={`React with ${emoji}`}
                        className="p-1.5 rounded hover:bg-white/[0.08] text-[#949BA4] hover:text-white transition cursor-pointer"
                      >
                        {REACTION_ICONS[emoji]}
                      </button>
                    ))}
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