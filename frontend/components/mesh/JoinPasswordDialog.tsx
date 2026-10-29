"use client";

import { useEffect, useRef, useState } from "react";
import type { JoinResult } from "@/lib/mesh/MeshService";

interface Props {
  channelName: string;
  onJoin: (password: string) => Promise<JoinResult>;
  onClose: () => void;
}

const ERRORS: Partial<Record<JoinResult, string>> = {
  wrong_password: "Wrong password.",
  unknown: "This channel isn't nearby any more.",
  unsupported: "This channel needs a newer version of the app.",
};

export default function JoinPasswordDialog({ channelName, onJoin, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onJoin(password);
      if (result === "joined") return onClose();
      setError(ERRORS[result] ?? "Couldn't join.");
      if (result === "wrong_password") inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-password-title"
        onSubmit={submit}
        className="w-full max-w-sm bg-[#12141A] border border-white/[0.08] rounded-xl p-5 shadow-2xl"
      >
        <h2 id="join-password-title" className="text-base font-bold text-white tracking-tight break-words">
          🔒 Join #{channelName}
        </h2>
        <p className="text-[12px] text-[#949BA4] mt-1 leading-relaxed">
          This channel is encrypted. Ask a member for the password.
        </p>
        <label className="block mt-4">
          <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Password</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            disabled={busy}
            aria-invalid={!!error}
            className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] focus:border-white/[0.18] rounded px-2.5 py-2 text-sm text-[#F2F3F5] outline-none disabled:opacity-60"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-[#F23F43]">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 text-[#F2F3F5] text-xs font-semibold rounded-md transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || busy}
            className="px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] disabled:opacity-40 disabled:cursor-not-allowed text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
          >
            {busy ? "Checking…" : "Join"}
          </button>
        </div>
      </form>
    </div>
  );
}
