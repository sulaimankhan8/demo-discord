"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { soundFx } from "@/lib/soundFx";

export default function Page() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const getAvatarColor = (name: string) => {
    if (!name) return "#5865F2";
    const colors = ["#5865F2", "#23A55A", "#F0B232", "#F23F43", "#9B59B6", "#1ABC9C"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  const login = async () => {
    if (!username.trim()) {
      setError("Please enter a display username.");
      return;
    }

    setLoading(true);
    setError(null);
    soundFx.playPop();

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim() }),
      });

      if (!res.ok) throw new Error(`Status ${res.status}`);

      const user = await res.json();
      localStorage.setItem("user", JSON.stringify(user));
      soundFx.playJoin();
      router.push("/chat");
    } catch (err: any) {
      console.warn("Using guest local fallback session:", err);
      const guestUser = {
        id: "usr-" + Math.random().toString(36).substring(2, 9),
        username: username.trim(),
      };
      localStorage.setItem("user", JSON.stringify(guestUser));
      soundFx.playJoin();
      router.push("/chat");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#08090C] flex flex-col items-center justify-center p-4 font-sans text-[#F2F3F5] select-none relative">
      {/* Studio Hairline Card */}
      <div className="w-full max-w-[400px] bg-[#12141A] border border-white/[0.08] rounded-2xl p-8 shadow-2xl shadow-black/80 relative z-10">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold mb-4 shadow-lg border border-white/10 transition-colors duration-200"
            style={{ backgroundColor: getAvatarColor(username) }}
          >
            {username ? username.charAt(0).toUpperCase() : (
              <svg className="w-7 h-7 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
          </div>

          <h1 className="text-xl font-bold tracking-tight text-white">
            Realtime Workspace
          </h1>
          <p className="text-xs text-[#949BA4] mt-1 font-mono">
            SFU WebRTC Voice & Distributed Stream Engine
          </p>
        </div>

        {error && (
          <div className="mb-4 p-2.5 bg-[#F23F43]/10 border border-[#F23F43]/30 rounded-lg text-[#F23F43] text-xs text-center font-medium">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider mb-2">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="e.g. Alex, Neo, Trinity"
              maxLength={24}
              className="w-full px-3.5 py-2.5 bg-[#0E0F14] border border-white/[0.08] focus:border-[#5865F2] focus:ring-1 focus:ring-[#5865F2] rounded-lg text-sm text-white placeholder-[#6D737F] outline-none transition font-medium"
              autoFocus
            />
          </div>

          <button
            onClick={login}
            disabled={loading || !username.trim()}
            className="w-full py-2.5 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg text-sm transition shadow-md shadow-[#5865F2]/20 flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99]"
          >
            {loading ? (
              <span>Connecting...</span>
            ) : (
              <span>Enter Workspace →</span>
            )}
          </button>
        </div>

        {/* Telemetry Footer */}
        <div className="mt-6 pt-4 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-[#6D737F] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#23A55A]" />
            <span>SFU Node Ready</span>
          </div>
          <span>Mediasoup v3 • Redis</span>
        </div>
      </div>
    </div>
  );
}
