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
  const [showSidebar, setShowSidebar] = useState(false);

  
  /* 🔥 NEW — history state */
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const oldestSnowflakeRef = useRef<string | null>(null);
  /* ======================================================== */

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null); // 🔥 NEW
  const typingTimer = useRef<any>(null);
  const isPrependingRef = useRef(false);

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


    /* ---------- 🔥 INITIAL HISTORY LOAD ---------- */
  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/messages?limit=50`)
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data.messages ?? data)) {
          console.error("Invalid messages payload:", data);
          return;
        }

        const msgs = data.messages ?? data;

        setMessages(msgs);
        setHasMoreHistory(data.hasMore ?? true);

        if (msgs.length > 0) {
          oldestSnowflakeRef.current = msgs[0].snowflake;
        }
      });
  }, []);

  /* 🔥 NEW — LOAD OLDER HISTORY */
  const loadOlderHistory = async () => {
    if (!hasMoreHistory || loadingHistory || !oldestSnowflakeRef.current) return;

    setLoadingHistory(true);

    const container = containerRef.current;
    const prevHeight = container?.scrollHeight ?? 0;

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/messages?limit=50&before=${oldestSnowflakeRef.current}`
    );
    const data = await res.json();

    const older = data.messages ?? data;

    if (older.length > 0) {
      oldestSnowflakeRef.current = older[0].snowflake;
      isPrependingRef.current = true;
      setMessages((prev) => [...older, ...prev]);
    }

    setHasMoreHistory(data.hasMore ?? older.length === 50);
    setLoadingHistory(false);

    // 🔥 Preserve scroll position
    requestAnimationFrame(() => {
      if (container) {
        container.scrollTop =
          container.scrollHeight - prevHeight + container.scrollTop;
      }
    });
  };

  /* 🔥 NEW — SCROLL DETECTION */
   const handleScroll = () => {
    if (loadingHistory || !hasMoreHistory) return;
    if (!containerRef.current) return;
    if (containerRef.current.scrollTop < 120) {
      loadOlderHistory();
    }
  };


  /* ---------- realtime messages ---------- */
   useEffect(() => {
    socket.on("new-message", (msg: Message) => {
      setMessages((prev) => {
        if (prev.find((m) => m.snowflake === msg.snowflake)) return prev;

        return [...prev, msg];

      });
    });

    // batch ACK
socket.on("message:ack:batch", ({ snowflakes }) => {
  setMessages((prev) =>
    prev.map((m) =>
      snowflakes.includes(m.snowflake)
        ? { ...m, id: m.id ?? "persisted" }
        : m
    )
  );
});

// (optional) keep single ACK handler for safety
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
  socket.off("message:ack:batch");
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
  if (isPrependingRef.current) {
    isPrependingRef.current = false;
    return;
  }
  bottomRef.current?.scrollIntoView({ behavior: "auto" });
}, [messages.length]);



  /* ---------- typing debounce ---------- */
  /* const handleTyping = () => {
    socket.emit("typing:start");
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit("typing:stop");
    }, 1200);
  }; */

  const handleTyping = () => {
  if (!socket.connected) return;

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

  // Helper function to generate avatar color based on username
  const getAvatarColor = (username: string) => {
    const colors = [
      "#7289DA", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", 
      "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F", "#BB8FCE"
    ];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };
  
  // Format timestamp like Discord (Today at 2:30 PM)
  const formatTimestamp = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (messageDate.getTime() === today.getTime()) {
      return `Today at ${time}`;
    } else if (messageDate.getTime() === today.getTime() - 86400000) {
      return `Yesterday at ${time}`;
    } else {
      return date.toLocaleDateString() + " at " + time;
    }
  };

  const getDeliveryStatus = (m: Message) => {
  if (!m.id) return "sent";
  return "delivered";
};

  // Group messages by date
  const groupMessagesByDate = (messages: Message[]) => {
    const groups: { [date: string]: Message[] } = {};
    
    messages.forEach(message => {
      const date = new Date(message.createdAt);
      const dateKey = date.toDateString();
      
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      
      groups[dateKey].push(message);
    });
    
    return groups;
  };

  const messageGroups = groupMessagesByDate(messages);

  /* ================== UI ================== */

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 overflow-hidden">
      {/* Mobile Sidebar Toggle */}
      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-indigo-600 rounded-md"
        onClick={() => setShowSidebar(!showSidebar)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* ================= LEFT — ONLINE USERS ================= */}
      <div className={`${showSidebar ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed md:relative w-64 h-full border-r border-gray-800 p-4 bg-gray-800 overflow-y-auto flex-shrink-0 transition-transform duration-300 z-40`}>
        <div className="flex justify-between items-center mb-4">
          <div className="font-semibold text-gray-300 uppercase text-xs tracking-wider">Online Users</div>
          <button
            className="md:hidden p-1 rounded hover:bg-gray-700"
            onClick={() => setShowSidebar(false)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div className="space-y-1">
          {onlineUsers.map((u) => (
            <div
              key={u.userId}
              className="flex items-center p-2 rounded hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <div className="relative mr-3">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
                  style={{ backgroundColor: getAvatarColor(u.username) }}
                >
                  {u.username.charAt(0).toUpperCase()}
                </div>
                <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-gray-800"></div>
              </div>
              <div className="text-sm text-gray-300 truncate">{u.username}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Sidebar Overlay */}
      {showSidebar && (
        <div 
          className="md:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
          onClick={() => setShowSidebar(false)}
        />
      )}

      {/* ================= RIGHT — CHAT ================= */}
      <div className="flex-1 flex flex-col h-full max-w-4xl mx-auto w-full">
        {/* -------- Messages (scrollable) -------- */}
        <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 bg-gray-900"
      >
        {/* 🔥 START OF HISTORY MARKER */}
        {!hasMoreHistory && (
          <div className="text-center text-xs text-gray-500 my-4">
            — Start of history —
          </div>
        )}

        {loadingHistory && (
          <div className="text-center text-xs text-gray-400 my-2">
            Loading older messages…
          </div>
        )}

          {Object.entries(messageGroups).map(([dateKey, dateMessages]) => (
            <div key={dateKey}>
              {/* Date separator */}
              <div className="flex items-center justify-center my-4">
                <div className="bg-gray-800 px-3 py-1 rounded-full text-xs text-gray-400">
                  {dateKey === new Date().toDateString() ? 'Today' : 
                   dateKey === new Date(Date.now() - 86400000).toDateString() ? 'Yesterday' : 
                   dateKey}
                </div>
              </div>
              
              {/* Messages for this date */}
              <div className="space-y-1">
                {dateMessages.map((m, i) => {
                  const isMe = m.userId === user?.id;
                  const prev = dateMessages[i - 1];
                  const isSameUserAsPrev = prev && prev.userId === m.userId;
                  const next = dateMessages[i + 1];
                  const isSameUserAsNext = next && next.userId === m.userId;

                  return (
                    <div
                      key={m.snowflake}
                      className={`flex ${isMe ? "justify-end" : "justify-start"} group`}
                    >
                      <div className={`flex ${isMe ? "flex-row-reverse" : "flex-row"} items-end max-w-xs lg:max-w-md xl:max-w-lg`}>
                        {!isMe && !isSameUserAsPrev && (
                          <div 
                            className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium mr-2 flex-shrink-0"
                            style={{ backgroundColor: getAvatarColor(m.username) }}
                          >
                            {m.username.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {!isMe && isSameUserAsPrev && (
                          <div className="w-10 mr-2 flex-shrink-0"></div>
                        )}
                        
                        <div className={`${isMe ? "items-end" : "items-start"} flex flex-col`}>
                          {!isMe && !isSameUserAsPrev && (
                            <div className="text-xs text-gray-400 mb-1 ml-1">{m.username}</div>
                          )}
                          
                          <div className={`${isMe ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-100"} px-4 py-2 rounded-lg ${isMe ? "rounded-br-sm" : "rounded-bl-sm"} relative`}>
                            <div className="text-sm whitespace-pre-wrap break-words">
  {m.content}
</div>

{isMe && (
  <div className="mt-1 text-[10px] text-gray-400 text-right">
    {getDeliveryStatus(m) === "sent" && "✔"}
    {getDeliveryStatus(m) === "delivered" && "✔✔"}
  </div>
)}

                            
                            {/* Timestamp - only visible on hover for desktop */}
                            <div className={`absolute ${isMe ? "left-0 -translate-x-full" : "right-0 translate-x-full"} top-0 text-xs text-gray-400 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap`}>
                              {formatTimestamp(m.createdAt)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          
          {typingUser && (
            <div className="flex justify-start">
              <div className="flex items-end">
                <div 
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium mr-2 flex-shrink-0"
                  style={{ backgroundColor: getAvatarColor(typingUser) }}
                >
                  {typingUser.charAt(0).toUpperCase()}
                </div>
                <div className="bg-gray-800 px-4 py-2 rounded-lg rounded-bl-sm">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          <div ref={bottomRef} />
        </div>

        {/* -------- Input (fixed bottom) -------- */}
        <div className="p-4 bg-gray-800 border-t border-gray-700">
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  handleTyping();
                }}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Message #general"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 placeholder-gray-400 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
            <button
              onClick={send}
              className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-800"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}