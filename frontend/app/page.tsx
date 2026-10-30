"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { soundFx } from "@/lib/soundFx";
import DownloadApp from "@/components/DownloadApp";

export default function Page() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const getAvatarColor = (name: string) => {
    if (!name) return "var(--avatar-0)";
    const colors = ["var(--avatar-0)", "var(--avatar-1)", "var(--avatar-2)", "var(--avatar-3)", "var(--avatar-4)", "var(--avatar-5)"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  /** Saves a local-only user (no backend) and opens the offline mesh. */
  const enterOffline = (name: string) => {
    localStorage.setItem(
      "user",
      JSON.stringify({ id: "usr-" + Math.random().toString(36).substring(2, 9), username: name }),
    );
    soundFx.playJoin();
    router.push("/mesh");
  };

  const login = async (offline = false) => {
    const name = username.trim();
    if (!name) {
      setError("Please enter a display username.");
      return;
    }

    setError(null);
    soundFx.playPop();

    // No internet, or asked for offline: skip the backend entirely.
    if (offline || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      enterOffline(name);
      return;
    }

    setLoading(true);
    // Don't hang when the backend is unreachable: give up after 4 s and go offline.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Status ${res.status}`);

      const user = await res.json();
      localStorage.setItem("user", JSON.stringify(user));
      soundFx.playJoin();
      router.push("/chat");
    } catch (err) {
      console.warn("Backend unreachable, entering offline mesh:", err);
      enterOffline(name);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-4 font-sans text-ink select-none relative">
      {/* Get the Android app: first thing on the page */}
      <div className="w-full max-w-[400px] mb-4 relative z-10">
        <DownloadApp />
      </div>

      {/* Studio Hairline Card */}
      <div className="w-full max-w-[400px] bg-surface-1 border border-white/[0.08] rounded-2xl p-8 shadow-2xl shadow-black/80 relative z-10">
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

          <h1 className="font-display text-4xl leading-none text-white">
            Realtime Workspace
          </h1>
          <p className="text-xs text-dim mt-1 font-mono">
            SFU WebRTC Voice & Distributed Stream Engine
          </p>
        </div>

        {error && (
          <div className="mb-4 p-2.5 bg-danger/10 border border-danger/30 rounded-lg text-danger text-xs text-center font-medium">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-dim uppercase tracking-wider mb-2">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void login()}
              placeholder="e.g. Alex, Neo, Trinity"
              maxLength={24}
              className="w-full px-3.5 py-2.5 bg-surface-0 border border-white/[0.08] focus:border-accent focus:ring-1 focus:ring-accent rounded-lg text-sm text-white placeholder-muted outline-none transition font-medium"
              autoFocus
            />
          </div>

          <button
            onClick={() => void login()}
            disabled={loading || !username.trim()}
            className="w-full py-2.5 bg-accent hover:bg-accent-hover brut disabled:opacity-50 disabled:cursor-not-allowed text-on-accent font-semibold rounded-lg text-sm transition shadow-md shadow-accent/20 flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99]"
          >
            {loading ? (
              <span>Connecting...</span>
            ) : (
              <span>Enter Workspace →</span>
            )}
          </button>

          <button
            onClick={() => void login(true)}
            disabled={!username.trim()}
            className="w-full py-2.5 bg-surface-0 hover:bg-surface-3 border border-mesh/40 text-mesh font-semibold rounded-lg text-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Enter offline · Bluetooth mesh</span>
          </button>
          <p className="text-[11px] text-muted text-center leading-relaxed">
            No internet or server? Offline works phone to phone. If the server doesn&apos;t answer in 4 seconds, you&apos;re taken offline automatically.
          </p>
        </div>

        {/* Telemetry Footer */}
        <div className="mt-6 pt-4 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-muted font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ok" />
            <span>SFU Node Ready</span>
          </div>
          <span>Mediasoup v3 • Redis</span>
        </div>
      </div>
    </div>
  );
}
