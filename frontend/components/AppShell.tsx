"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { soundFx } from "@/lib/soundFx";
import MeshIcon from "@/components/icons/MeshIcon";

type Platform = "ios" | "android" | "web";

// Phone tab bar. Icon paths match the desktop rail.
const TABS: { href: string; label: string; icon: string }[] = [
  { href: "/dashboard", label: "Hub", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { href: "/chat", label: "Chat", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { href: "/voice", label: "Voice", icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" },
  { href: "/mesh", label: "Mesh", icon: "" },
];

const PAGE_TITLES: Record<string, { kicker: string; title: string }> = {
  "/dashboard": { kicker: "REALTIME CLUSTER", title: "Hub" },
  "/chat": { kicker: "TEXT CHANNEL", title: "general-chat" },
  "/voice": { kicker: "VOICE · SFU", title: "global-voice" },
  "/mesh": { kicker: "OFFLINE // BLUETOOTH", title: "Mesh" },
};

interface AppShellProps {
  children: React.ReactNode;
  activeChannel?: string;
  onlineCount?: number;
  /** Lets the page open without a login (used by the offline mesh). Off by default. */
  allowOffline?: boolean;
}

export default function AppShell({ children, activeChannel = "general-chat", onlineCount = 1, allowOffline = false }: AppShellProps) {
  // The app build uses trailing slashes ("/chat/"); drop them so the checks below match on
  // both web and app. On the web the path never has one, so nothing changes there.
  const pathname = usePathname().replace(/(.)\/+$/, "$1");
  const router = useRouter();
  const [user, setUser] = useState<{ id?: string; username?: string } | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  // Safe to read on first render: the shell renders nothing until the user effect runs.
  const [platform] = useState<Platform>(() => {
    const p = Capacitor.getPlatform();
    return p === "ios" || p === "android" ? p : "web";
  });

  useEffect(() => {
    const raw = localStorage.getItem("user");
    if (raw) {
      try {
        setUser(JSON.parse(raw));
      } catch {
        if (allowOffline) setUser({ username: "Guest" });
        else router.push("/");
      }
    } else if (allowOffline) {
      setUser({ username: "Guest" });
    } else {
      router.push("/");
    }
  }, [router, allowOffline]);

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
    if (!name) return "var(--avatar-0)";
    const colors = ["var(--avatar-0)", "var(--avatar-1)", "var(--avatar-2)", "var(--avatar-3)", "var(--avatar-4)", "var(--avatar-5)"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  if (!user) return null;

  const isVoiceActive = pathname === "/voice";
  const isChatActive = pathname === "/chat";
  const isMeshActive = pathname === "/mesh";
  const isIos = platform === "ios";
  const page = PAGE_TITLES[pathname] ?? { kicker: "DEMO DISCORD", title: activeChannel };

  return (
    // The offline mesh switches the whole screen to the 1-bit theme.
    <div
      className={`flex flex-col md:flex-row h-[100dvh] w-screen overflow-hidden bg-canvas text-ink select-none font-sans pt-safe md:pb-safe ${
        isMeshActive ? "theme-1bit" : ""
      }`}
    >
      {/* ---------------- PHONE: TOP BAR ---------------- */}
      <header className="md:hidden shrink-0 flex items-end gap-2 px-4 pt-2 pb-2.5 bg-surface-0 border-b-2 border-black [.theme-1bit_&]:border-white">
        <div className="flex-1 min-w-0">
          <div className={`font-mono text-[10px] tracking-[0.12em] ${isMeshActive ? "text-ink" : "text-dim"}`}>
            {page.kicker}
            {!isMeshActive && <span className="text-ok"> · ● ONLINE</span>}
          </div>
          <h1 className={`font-display leading-none truncate mt-1 ${isIos ? "text-[34px]" : "text-[28px]"}`}>
            {pathname === "/chat" && <span className="italic text-accent">#</span>}
            {page.title}
          </h1>
        </div>
        <div className="flex items-center gap-1.5 pb-0.5">
          <button
            onClick={toggleMute}
            aria-label={isMicMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={isMicMuted}
            className={`w-10 h-10 flex items-center justify-center rounded-md brut cursor-pointer ${
              isMicMuted ? "bg-danger text-on-danger" : "bg-surface-3 text-ink"
            }`}
          >
            <svg className="w-[18px] h-[18px] fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={isMicMuted ? "M19 19L5 5m14 0L5 19M12 1v6m0 4v4m-4-4h8" : TABS[2].icon}
              />
            </svg>
          </button>
          <button
            onClick={toggleDeafen}
            aria-label={isDeafened ? "Undeafen" : "Deafen"}
            aria-pressed={isDeafened}
            className={`w-10 h-10 flex items-center justify-center rounded-md brut cursor-pointer ${
              isDeafened ? "bg-danger text-on-danger" : "bg-surface-3 text-ink"
            }`}
          >
            <svg className="w-[18px] h-[18px] fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          </button>
          <button
            onClick={logout}
            aria-label="Disconnect and exit"
            className="w-10 h-10 flex items-center justify-center rounded-md text-dim hover:text-danger cursor-pointer"
          >
            <svg className="w-[18px] h-[18px] fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* ---------------- COLUMN 1: SERVER RAIL (72px) ---------------- */}
      <nav className="w-[72px] bg-surface-0 hidden md:flex flex-col items-center py-3 gap-2 border-r border-white/[0.04] z-20 shrink-0">
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
                ? "bg-accent rounded-[16px] text-on-accent"
                : "bg-surface-2 text-dim group-hover:bg-accent group-hover:text-on-accent"
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
                ? "bg-surface-3 text-accent border-accent/40 rounded-[16px]"
                : "bg-surface-2 text-dim group-hover:bg-surface-3 group-hover:text-white"
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
                ? "bg-ok/20 text-ok border-ok/50 rounded-[16px]"
                : "bg-surface-2 text-dim group-hover:bg-ok/15 group-hover:text-ok"
            }`}
          >
            {/* Live Audio Waves SVG */}
            <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
        </Link>

        {/* Offline Mesh (no internet) */}
        <Link
          href="/mesh"
          className="group relative flex items-center justify-center w-full focus:outline-none"
          title="Offline Mesh (no internet)"
        >
          <div
            className={`absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200 ${
              isMeshActive ? "h-10" : "h-0 group-hover:h-5"
            }`}
          />
          <div
            className={`w-12 h-12 rounded-[24px] group-hover:rounded-[16px] flex items-center justify-center transition-all duration-200 border border-white/[0.06] shadow-md ${
              isMeshActive
                ? "bg-warn/15 text-warn border-warn/50 rounded-[16px]"
                : "bg-surface-2 text-dim group-hover:bg-warn/10 group-hover:text-warn"
            }`}
          >
            <MeshIcon />
          </div>
        </Link>

        <div className="mt-auto flex flex-col items-center gap-2">
          {/* Logout / Exit */}
          <button
            onClick={logout}
            title="Disconnect & Exit"
            className="w-10 h-10 rounded-[20px] hover:rounded-[12px] bg-surface-2 hover:bg-danger/20 text-dim hover:text-danger flex items-center justify-center transition-all duration-200 cursor-pointer"
          >
            <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </nav>

      {/* ---------------- COLUMN 2: CHANNEL DRAWER & HARDWARE DOCK (240px) ---------------- */}
      <aside className="w-60 bg-surface-1 hidden md:flex flex-col justify-between border-r border-white/[0.04] shrink-0 z-10">
        {/* Workspace Header */}
        <div>
          <header className="h-12 px-4 border-b border-white/[0.05] flex items-center justify-between font-semibold text-sm text-white shadow-sm hover:bg-white/[0.02] cursor-pointer transition">
            <div className="flex items-center gap-2 truncate">
              <span className="w-2 h-2 rounded-full bg-ok shadow-[0_0_8px_rgba(35,165,90,0.6)]" />
              <span className="truncate font-semibold tracking-tight text-[13px]">Realtime Cluster</span>
            </div>
            <svg className="w-4 h-4 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </header>

          {/* Real Functional Channels Only */}
          <div className="p-2 space-y-4 overflow-y-auto max-h-[calc(100vh-120px)]">
            {/* TEXT CHANNEL */}
            <div>
              <div className="px-2 py-1 text-[11px] font-semibold text-muted tracking-wider uppercase">
                Text Channels
              </div>
              <div className="mt-1 space-y-0.5">
                <Link
                  href="/chat"
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                    isChatActive
                      ? "bg-white/[0.08] text-white"
                      : "text-dim hover:bg-white/[0.04] hover:text-body"
                  }`}
                >
                  <svg className="w-4 h-4 text-muted shrink-0 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                  </svg>
                  <span className="truncate">general-chat</span>
                </Link>
              </div>
            </div>

            {/* VOICE CHANNEL */}
            <div>
              <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-muted tracking-wider uppercase">
                <span>Voice Channels</span>
                <span className="text-[10px] text-ok font-mono">SFU</span>
              </div>
              <div className="mt-1 space-y-0.5">
                <Link
                  href="/voice"
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                    isVoiceActive
                      ? "bg-ok/15 text-ok font-semibold"
                      : "text-dim hover:bg-white/[0.04] hover:text-body"
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <svg className="w-4 h-4 shrink-0 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <span className="truncate">global-voice</span>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.05] text-dim font-mono">
                    HD
                  </span>
                </Link>
              </div>
            </div>

            {/* OFFLINE MESH CHANNEL */}
            <div>
              <div className="flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-muted tracking-wider uppercase">
                <span>Offline Mesh</span>
                <span className="text-[10px] text-warn font-mono">BLE</span>
              </div>
              <div className="mt-1 space-y-0.5">
                <Link
                  href="/mesh"
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                    isMeshActive
                      ? "bg-warn/15 text-warn font-semibold"
                      : "text-dim hover:bg-white/[0.04] hover:text-body"
                  }`}
                >
                  <MeshIcon className="w-4 h-4 shrink-0" />
                  <span className="truncate">nearby</span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* ---------------- PERSISTENT BOTTOM USER & VOICE STATUS DOCK ---------------- */}
        <div className="border-t border-white/[0.05] bg-surface-0/90 p-2 flex flex-col gap-1.5">
          {/* RTC Connection Banner */}
          {isVoiceActive && (
            <div className="flex items-center justify-between px-2 py-1 bg-ok/10 border border-ok/30 rounded-md text-[11px]">
              <div className="flex items-center gap-1.5 text-ok font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                <span>Voice Connected</span>
              </div>
              <span className="text-[10px] text-ok font-mono">18ms</span>
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
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-ok border-2 border-surface-0" />
              </div>
              <div className="flex flex-col truncate">
                <span className="text-xs font-semibold text-ink truncate leading-tight">
                  {user.username}
                </span>
                <span className="text-[10px] text-dim font-mono">Online</span>
              </div>
            </div>

            {/* Hardware Controls */}
            <div className="flex items-center gap-1 text-dim">
              <button
                onClick={toggleMute}
                title={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
                className={`p-1.5 rounded hover:bg-white/[0.08] transition cursor-pointer ${
                  isMicMuted ? "text-danger bg-danger/15" : "hover:text-white"
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
                  isDeafened ? "text-danger bg-danger/15" : "hover:text-white"
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
      <main className="flex-1 flex flex-col min-w-0 bg-surface-2 relative overflow-hidden">
        {children}
      </main>

      {/* ---------------- PHONE: BOTTOM TABS (Android: filled block, iOS: tinted icon) ---------------- */}
      <nav
        aria-label="Main"
        className="md:hidden shrink-0 grid grid-cols-4 bg-surface-0 border-t-2 border-black [.theme-1bit_&]:border-white pb-safe"
      >
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          const isMesh = tab.href === "/mesh";
          const icon = isMesh ? (
            <MeshIcon className="w-5 h-5" />
          ) : (
            <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={tab.icon} />
            </svg>
          );
          const tint = active ? (isMesh ? "text-mesh" : "text-accent") : isMesh ? "text-mesh/80" : "text-dim";
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-1 min-h-[56px] pt-2 pb-1.5 ${
                isIos ? `text-[10px] ${tint}` : `text-[12px] ${active ? "text-ink font-semibold" : tint}`
              }`}
            >
              {isIos ? (
                icon
              ) : (
                <span
                  className={`flex items-center justify-center w-14 h-7 rounded-md ${
                    active ? `${isMesh ? "bg-mesh" : "bg-accent"} text-on-accent brut` : ""
                  }`}
                >
                  {icon}
                </span>
              )}
              <span className={isMeshActive ? "font-mono uppercase" : ""}>{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
