"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { soundFx } from "@/lib/soundFx";

interface AppShellProps {
  children: React.ReactNode;
  activeChannel?: string;
  onlineCount?: number;
}

export default function AppShell({ children, activeChannel = "general-chat", onlineCount = 1 }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{ id?: string; username?: string } | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem("user");
    if (raw) {
      try {
        setUser(JSON.parse(raw));
      } catch {
        router.push("/");
      }
    } else {
      router.push("/");
    }
  }, [router]);

  const toggleMute = () => {
    const next = !isMicMuted;
    setIsMicMuted(next);
    if (next) soundFx.playMute();
    else soundFx.playUnmute();
  };

  const toggleDeafen = () => {
    setIsDeafened(!isDeafened);
    soundFx.playPop();
  };

  const logout = () => {
    soundFx.playLeave();
    localStorage.removeItem("user");
    router.push("/");
  };

  const getAvatarColor = (name: string) => {
    if (!name) return "#5865F2";
    const colors = ["#5865F2", "#23A55A", "#F0B232", "#F23F43", "#9B59B6", "#1ABC9C"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  if (!user) return null;

  const isVoiceActive = pathname === "/voice";
  const isChatActive = pathname === "/chat";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#08090C] text-[#F2F3F5] select-none font-sans">
      {/* ---------------- COLUMN 1: SERVER RAIL (72px) ---------------- */}
      <nav className="w-[72px] bg-[#0E0F14] flex flex-col items-center py-3 gap-2 border-r border-white/[0.04] z-20 shrink-0">
        {/* Hub / Dashboard Button */}
        <Link
          href="/dashboard"
          className="group relative flex items-center justify-center w-full focus:outline-none"
          title="Workspace Hub"
        >
          <div
            className={`absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200 ${
              pathname === "/dashboard" ? "h-10" : "h-0 group-hover:h-5"
            }`}
          />
          <div
            className={`w-12 h-12 rounded-[24px] group-hover:rounded-[16px] flex items-center justify-center transition-all duration-200 shadow-md ${
              pathname === "/dashboard"
                ? "bg-[#5865F2] rounded-[16px] text-white"
                : "bg-[#171922] text-[#949BA4] group-hover:bg-[#5865F2] group-hover:text-white"
            }`}
          >
            {/* Sleek Geometric Pulse Hub SVG */}
            <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
        </Link>

        <div className="w-8 h-[2px] bg-white/[0.06] rounded-full my-1" />

        {/* Text Chat Server Icon */}
        <Link
          href="/chat"
          className="group relative flex items-center justify-center w-full focus:outline-none"
          title="Chat Channel"
        >
          <div
            className={`absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200 ${
              isChatActive ? "h-10" : "h-0 group-hover:h-5"
            }`}
          />
          <div
            className={`w-12 h-12 rounded-[24px] group-hover:rounded-[16px] flex items-center justify-center transition-all duration-200 border border-white/[0.06] shadow-md ${
              isChatActive
                ? "bg-[#1E212D] text-[#5865F2] border-[#5865F2]/40 rounded-[16px]"
                : "bg-[#171922] text-[#949BA4] group-hover:bg-[#1E212D] group-hover:text-white"
            }`}
          >
            {/* Chat Bubble SVG */}
            <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
        </Link>

        {/* SFU Voice Stage Shortcut */}
        <Link
          href="/voice"
          className="group relative flex items-center justify-center w-full focus:outline-none"
          title="Voice & Video Stage (SFU)"
        >
          <div
            className={`absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200 ${
              isVoiceActive ? "h-10" : "h-0 group-hover:h-5"
            }`}
          />
          <div
            className={`w-12 h-12 rounded-[24px] group-hover:rounded-[16px] flex items-center justify-center transition-all duration-200 border border-white/[0.06] shadow-md ${
              isVoiceActive
                ? "bg-[#23A55A]/20 text-[#23A55A] border-[#23A55A]/50 rounded-[16px]"
                : "bg-[#171922] text-[#949BA4] group-hover:bg-[#23A55A]/15 group-hover:text-[#23A55A]"
            }`}
          >
            {/* Live Audio Waves SVG */}
            <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
        </Link>

        <div className="mt-auto flex flex-col items-center gap-2">
          {/* Logout / Exit */}
          <button
            onClick={logout}
            title="Disconnect & Exit"
            className="w-10 h-10 rounded-[20px] hover:rounded-[12px] bg-[#171922] hover:bg-[#F23F43]/20 text-[#949BA4] hover:text-[#F23F43] flex items-center justify-center transition-all duration-200 cursor-pointer"
          >
            <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </nav>

      {/* ---------------- COLUMN 2: CHANNEL DRAWER & HARDWARE DOCK (240px) ---------------- */}
      <aside className="w-60 bg-[#12141A] flex flex-col justify-between border-r border-white/[0.04] shrink-0 z-10">
        {/* Workspace Header */}
        <div>
          <header className="h-12 px-4 border-b border-white/[0.05] flex items-center justify-between font-semibold text-sm text-white shadow-sm hover:bg-white/[0.02] cursor-pointer transition">
            <div className="flex items-center gap-2 truncate">
              <span className="w-2 h-2 rounded-full bg-[#23A55A] shadow-[0_0_8px_rgba(35,165,90,0.6)]" />
              <span className="truncate font-semibold tracking-tight text-[13px]">Realtime Cluster</span>
            </div>
            <svg className="w-4 h-4 text-[#949BA4]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </header>

          {/* Real Functional Channels Only */}
          <div className="p-2 space-y-4 overflow-y-auto max-h-[calc(100vh-120px)]">
            {/* TEXT CHANNEL */}
            <div>
              <div className="px-2 py-1 text-[11px] font-semibold text-[#6D737F] tracking-wider uppercase">
                Text Channels
              </div>
              <div className="mt-1 space-y-0.5">
                <Link
                  href="/chat"
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                    isChatActive
                      ? "bg-white/[0.08] text-white"
                      : "text-[#949BA4] hover:bg-white/[0.04] hover:text-[#DBDEE1]"
                  }`}
                >
                  <svg className="w-4 h-4 text-[#6D737F] shrink-0 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                  </svg>
                  <span className="truncate">general-chat</span>
                </Link>
              </div>
            </div>

            {/* VOICE CHANNEL */}
            <div>
              <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[#6D737F] tracking-wider uppercase">
                <span>Voice Channels</span>
                <span className="text-[10px] text-[#23A55A] font-mono">SFU</span>
              </div>
              <div className="mt-1 space-y-0.5">
                <Link
                  href="/voice"
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                    isVoiceActive
                      ? "bg-[#23A55A]/15 text-[#23A55A] font-semibold"
                      : "text-[#949BA4] hover:bg-white/[0.04] hover:text-[#DBDEE1]"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <svg className="w-4 h-4 shrink-0 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <span className="truncate">global-voice</span>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.05] text-[#949BA4] font-mono">
                    HD
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* ---------------- PERSISTENT BOTTOM USER & VOICE STATUS DOCK ---------------- */}
        <div className="border-t border-white/[0.05] bg-[#0E0F14]/90 p-2 flex flex-col gap-1.5">
          {/* RTC Connection Banner */}
          {isVoiceActive && (
            <div className="flex items-center justify-between px-2 py-1 bg-[#23A55A]/10 border border-[#23A55A]/30 rounded-md text-[11px]">
              <div className="flex items-center gap-1.5 text-[#23A55A] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-[#23A55A] animate-pulse" />
                <span>Voice Connected</span>
              </div>
              <span className="text-[10px] text-[#23A55A] font-mono">18ms</span>
            </div>
          )}

          {/* User Card */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 truncate">
              <div className="relative">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm"
                  style={{ backgroundColor: getAvatarColor(user.username || "") }}
                >
                  {user.username?.charAt(0).toUpperCase()}
                </div>
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#23A55A] border-2 border-[#0E0F14]" />
              </div>
              <div className="flex flex-col truncate">
                <span className="text-xs font-semibold text-[#F2F3F5] truncate leading-tight">
                  {user.username}
                </span>
                <span className="text-[10px] text-[#949BA4] font-mono">Online</span>
              </div>
            </div>

            {/* Hardware Controls */}
            <div className="flex items-center gap-1 text-[#949BA4]">
              <button
                onClick={toggleMute}
                title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
                className={`p-1.5 rounded hover:bg-white/[0.08] transition cursor-pointer ${
                  isMicMuted ? "text-[#F23F43] bg-[#F23F43]/15" : "hover:text-white"
                }`}
              >
                {isMicMuted ? (
                  <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 19L5 5m14 0L5 19M12 1v6m0 4v4m-4-4h8" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>

              <button
                onClick={toggleDeafen}
                title={isDeafened ? "Undeafen" : "Deafen"}
                className={`p-1.5 rounded hover:bg-white/[0.08] transition cursor-pointer ${
                  isDeafened ? "text-[#F23F43] bg-[#F23F43]/15" : "hover:text-white"
                }`}
              >
                <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ---------------- COLUMN 3: MAIN STAGE / CONTENT AREA ---------------- */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#171922] relative overflow-hidden">
        {children}
      </main>
    </div>
  );
}
