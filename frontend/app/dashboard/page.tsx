"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppShell from "@/components/AppShell";

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<{ id?: string; username?: string } | null>(null);

  useEffect(() => {
    const rawUser = localStorage.getItem("user");
    if (!rawUser) {
      router.push("/");
    } else {
      try {
        setUser(JSON.parse(rawUser));
      } catch {
        router.push("/");
      }
    }
  }, [router]);

  if (!user) return null;

  return (
    <AppShell activeChannel="dashboard" onlineCount={1}>
      <div className="h-full w-full bg-[#171922] text-[#F2F3F5] font-sans flex flex-col justify-between p-8 overflow-y-auto select-none">
        {/* TOP BANNER */}
        <header className="max-w-4xl w-full mx-auto flex items-center justify-between pb-6 border-b border-white/[0.05]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              Welcome back, {user.username}
            </h1>
            <p className="text-xs text-[#949BA4] mt-0.5 font-mono">
              Realtime Distributed Cluster • Node 01
            </p>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#23A55A]/15 border border-[#23A55A]/30 rounded-md text-xs font-mono text-[#23A55A]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#23A55A] animate-pulse" />
            <span>SFU & Stream Connected</span>
          </div>
        </header>

        {/* CHANNEL SELECTION CARDS */}
        <main className="max-w-4xl w-full mx-auto my-auto py-8">
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-[#949BA4] uppercase tracking-wider">
              Available Workspaces & Stages
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* TEXT STREAM CARD */}
            <Link
              href="/chat"
              className="group bg-[#0E0F14] hover:bg-[#12141A] border border-white/[0.06] hover:border-[#5865F2]/50 rounded-xl p-6 transition-all duration-200 shadow-lg flex flex-col justify-between cursor-pointer"
            >
              <div>
                <div className="w-10 h-10 rounded-lg bg-[#5865F2]/15 border border-[#5865F2]/30 flex items-center justify-center mb-4 text-[#5865F2]">
                  <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <h3 className="text-base font-bold text-white group-hover:text-[#5865F2] transition-colors flex items-center gap-2">
                  <span># general-chat</span>
                  <span className="text-[10px] bg-[#5865F2]/20 text-[#5865F2] font-mono px-2 py-0.5 rounded">
                    Stream Active
                  </span>
                </h3>
                <p className="text-xs text-[#949BA4] mt-2 leading-relaxed">
                  Real-time distributed messaging with 64-bit Snowflake cursor pagination, typing indicators, and Redis Streams persistence.
                </p>
              </div>

              <div className="mt-6 flex items-center justify-between pt-3 border-t border-white/[0.05] text-xs font-semibold text-[#5865F2]">
                <span>Enter Chat Stream</span>
                <span className="group-hover:translate-x-1 transition-transform font-mono">→</span>
              </div>
            </Link>

            {/* STAGE VOICE CARD */}
            <Link
              href="/voice"
              className="group bg-[#0E0F14] hover:bg-[#12141A] border border-white/[0.06] hover:border-[#23A55A]/50 rounded-xl p-6 transition-all duration-200 shadow-lg flex flex-col justify-between cursor-pointer"
            >
              <div>
                <div className="w-10 h-10 rounded-lg bg-[#23A55A]/15 border border-[#23A55A]/30 flex items-center justify-center mb-4 text-[#23A55A]">
                  <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <h3 className="text-base font-bold text-white group-hover:text-[#23A55A] transition-colors flex items-center gap-2">
                  <span>global-voice</span>
                  <span className="text-[10px] bg-[#23A55A]/20 text-[#23A55A] font-mono px-2 py-0.5 rounded">
                    SFU WebRTC
                  </span>
                </h3>
                <p className="text-xs text-[#949BA4] mt-2 leading-relaxed">
                  Studio multi-peer audio and video routing with Mediasoup C++ worker pool, in-place acoustic active speaker detection, and SVC layers.
                </p>
              </div>

              <div className="mt-6 flex items-center justify-between pt-3 border-t border-white/[0.05] text-xs font-semibold text-[#23A55A]">
                <span>Connect to Stage</span>
                <span className="group-hover:translate-x-1 transition-transform font-mono">→</span>
              </div>
            </Link>
          </div>
        </main>

        {/* FOOTER */}
        <footer className="max-w-4xl w-full mx-auto text-center text-[11px] text-[#6D737F] font-mono pt-4 border-t border-white/[0.05]">
          Realtime Architecture • Next.js 16 • React 19 • Mediasoup v3 • Redis Streams
        </footer>
      </div>
    </AppShell>
  );
}