"use client";

import { useEffect, useRef, useState } from "react";
import type { JoinResult } from "@/lib/mesh/MeshService";

interface Props {
  onJoin: (text: string) => Promise<JoinResult>;
  onClose: () => void;
}

const ERRORS: Partial<Record<JoinResult, string>> = {
  invalid_invite: "That isn't a valid invite. Check it was copied in full.",
  expired_invite: "This invite has expired. Ask for a new one.",
};

export default function InviteJoinDialog({ onJoin, onClose }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const result = await onJoin(text);
      if (result === "joined" || result === "waiting_for_key") return onClose();
      setError(ERRORS[result] ?? "Couldn't join.");
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
        aria-labelledby="invite-join-title"
        onSubmit={submit}
        className="w-full max-w-md bg-surface-1 border border-white/[0.08] rounded-xl p-5 shadow-2xl"
      >
        <h2 id="invite-join-title" className="font-display text-2xl leading-tight text-white">
          Join with an invite
        </h2>
        <p className="text-[12px] text-dim mt-1 leading-relaxed">
          Paste the invite someone shared with you. You&apos;re let in as soon as any admin of the channel is in reach.
        </p>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={4}
          placeholder="mesh-invite:…"
          aria-label="Invite text"
          aria-invalid={!!error}
          className="mt-3 w-full bg-surface-3 border border-white/[0.06] focus:border-white/[0.18] rounded px-2.5 py-2 text-[11px] font-mono text-ink placeholder-muted outline-none break-all resize-none"
        />
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 text-ink text-xs font-semibold rounded-md transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="px-4 py-2 bg-warn hover:bg-warn-hover brut disabled:opacity-40 disabled:cursor-not-allowed text-canvas text-xs font-semibold rounded-md transition cursor-pointer"
          >
            {busy ? "Joining…" : "Join"}
          </button>
        </div>
      </form>
    </div>
  );
}
