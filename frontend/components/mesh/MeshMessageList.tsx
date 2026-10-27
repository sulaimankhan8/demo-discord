"use client";

import { useEffect, useRef } from "react";
import type { MeshChatMessage } from "@/lib/mesh/MeshService";
import { avatarColor, formatTime, hopLabel, MESH_ACCENT } from "./meshUi";

export default function MeshMessageList({ messages }: { messages: MeshChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 select-text">
      <div className="pt-6 pb-4 px-2">
        <div
          className="w-10 h-10 rounded-lg bg-[#1E212D] border border-white/[0.08] flex items-center justify-center mb-3"
          style={{ color: MESH_ACCENT }}
        >
          <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-white tracking-tight">Welcome to #nearby</h3>
        <p className="text-xs text-[#949BA4] mt-0.5 max-w-md">
          Messages here go phone to phone with no internet. Phones in range pass them on, up to 7 hops. Anyone
          nearby can read this room.
        </p>
        <div className="h-[1px] bg-white/[0.05] mt-4 mb-2" />
      </div>

      {messages.length === 0 && (
        <p className="px-2 text-xs text-[#6D737F] font-mono">No messages yet.</p>
      )}

      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const clustered =
          prev && prev.fingerprint === m.fingerprint && Math.abs(m.timestamp - prev.timestamp) < 300_000;

        return (
          <div
            key={m.id}
            className={`group flex items-start gap-3 px-2 py-1 rounded hover:bg-white/[0.02] transition-colors ${
              clustered ? "mt-0" : "mt-2"
            }`}
          >
            {!clustered ? (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5 shadow-sm"
                style={{ backgroundColor: avatarColor(m.fingerprint) }}
              >
                {m.nickname.charAt(0).toUpperCase() || "?"}
              </div>
            ) : (
              <div className="w-9 shrink-0 text-right text-[10px] text-[#6D737F] opacity-0 group-hover:opacity-100 font-mono select-none pt-0.5">
                {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            )}

            <div className="flex-1 min-w-0">
              {!clustered && (
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span
                    className="text-[13px] font-semibold tracking-tight"
                    style={{ color: m.mine ? MESH_ACCENT : "#F2F3F5" }}
                  >
                    {m.nickname}
                  </span>
                  <span className="text-[10px] text-[#6D737F] font-mono" title="Key fingerprint">
                    #{m.fingerprint.slice(0, 4)}
                  </span>
                  <span className="text-[10px] text-[#6D737F] font-mono">{formatTime(m.timestamp)}</span>
                </div>
              )}
              <div className="flex items-start gap-2">
                <div className="flex-1 text-[13px] text-[#DBDEE1] leading-[19px] whitespace-pre-wrap break-words">
                  {m.text}
                </div>
                <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-[#6D737F] font-mono opacity-0 group-hover:opacity-100 transition-opacity">
                  {hopLabel(m.hops)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
