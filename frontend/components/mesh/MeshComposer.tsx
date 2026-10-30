"use client";

import { useState } from "react";
import { MAX_TEXT_BYTES } from "@/lib/mesh/payloads";
import { soundFx } from "@/lib/soundFx";

const encoder = new TextEncoder();

interface Props {
  disabled: boolean;
  onSend: (text: string) => void;
  placeholder?: string;
}

export default function MeshComposer({ disabled, onSend, placeholder = "Message phones nearby" }: Props) {
  const [input, setInput] = useState("");
  const bytes = encoder.encode(input.trim()).length;
  const tooLong = bytes > MAX_TEXT_BYTES;
  const canSend = !disabled && bytes > 0 && !tooLong;

  const send = () => {
    if (!canSend) return;
    onSend(input.trim());
    soundFx.playPop();
    setInput("");
  };

  return (
    <div className="px-4 pb-4 pt-1 bg-surface-2">
      <div className="relative flex items-center bg-surface-3 border border-white/[0.06] focus-within:border-white/[0.18] rounded-lg px-4 py-2.5 transition">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={disabled}
          placeholder={disabled && placeholder.startsWith("Message") ? "Connecting…" : placeholder}
          aria-label={placeholder}
          className="w-full bg-transparent text-sm text-ink placeholder-muted outline-none font-medium disabled:cursor-not-allowed"
        />
        {bytes > MAX_TEXT_BYTES * 0.8 && (
          <span className={`ml-2 text-[10px] font-mono shrink-0 ${tooLong ? "text-danger" : "text-muted"}`}>
            {bytes}/{MAX_TEXT_BYTES}
          </span>
        )}
        <button
          onClick={send}
          disabled={!canSend}
          className="ml-2 px-3 py-1 bg-warn hover:bg-warn-hover brut disabled:opacity-40 disabled:cursor-not-allowed text-canvas text-xs font-semibold rounded transition cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  );
}
