"use client";

import { formatFingerprint } from "@/lib/mesh/identity";
import type { MeshSessionState } from "@/lib/mesh/meshSession";
import { avatarColor, hopLabel } from "./meshUi";

interface Props {
  state: MeshSessionState;
  onNickname: (name: string) => void;
  onSimPosition: (position: number | null) => void;
  onStopSim: () => void;
}

const SIM_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function MeshSidebar({ state, onNickname, onSimPosition, onStopSim }: Props) {
  const { me, peers, stats, mode } = state;

  return (
    <aside className="w-60 bg-[#12141A] border-l border-white/[0.04] p-3 overflow-y-auto shrink-0 hidden lg:flex flex-col gap-5">
      {/* This device */}
      {me && (
        <section>
          <SectionTitle>You</SectionTitle>
          <div className="px-2 mt-1 space-y-2">
            <label className="block">
              <span className="text-[10px] text-[#6D737F]">Name shown to others</span>
              <input
                key={me.nickname}
                defaultValue={me.nickname}
                maxLength={32}
                onBlur={(e) => onNickname(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="mt-0.5 w-full bg-[#1E212D] border border-white/[0.06] focus:border-white/[0.18] rounded px-2 py-1 text-xs text-[#F2F3F5] outline-none"
              />
            </label>
            <div>
              <span className="text-[10px] text-[#6D737F]">Your fingerprint</span>
              <div className="text-[11px] text-[#DBDEE1] font-mono mt-0.5">{formatFingerprint(me.fingerprint)}</div>
              <p className="text-[10px] text-[#6D737F] mt-1 leading-snug">
                Compare this in person to check someone is who they say they are.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Peers */}
      <section>
        <SectionTitle>Nearby — {peers.length}</SectionTitle>
        {peers.length === 0 ? (
          <p className="px-2 mt-1 text-[11px] text-[#6D737F]">
            {mode === "sim" ? "Open this page in another tab to add a phone." : "Looking for phones in range…"}
          </p>
        ) : (
          <div className="mt-1 space-y-0.5">
            {peers.map((p) => (
              <div key={p.key} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-white/[0.04]">
                <div className="relative">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                    style={{ backgroundColor: avatarColor(p.fingerprint) }}
                  >
                    {p.nickname.charAt(0).toUpperCase() || "?"}
                  </div>
                  <span
                    className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-[#12141A] ${
                      p.direct ? "bg-[#23A55A]" : "bg-[#F0B232]"
                    }`}
                  />
                </div>
                <div className="truncate flex-1">
                  <div className="text-xs font-medium text-[#DBDEE1] truncate">{p.nickname}</div>
                  <div className="text-[10px] text-[#6D737F] font-mono">
                    #{p.fingerprint.slice(0, 4)} · {hopLabel(p.hops)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Simulator controls */}
      {mode === "sim" && (
        <section>
          <SectionTitle>Simulation</SectionTitle>
          <div className="px-2 mt-1 space-y-2">
            <label className="block">
              <span className="text-[10px] text-[#6D737F]">This tab&apos;s position</span>
              <select
                value={state.simPosition ?? ""}
                onChange={(e) => onSimPosition(e.target.value === "" ? null : Number(e.target.value))}
                className="mt-0.5 w-full bg-[#1E212D] border border-white/[0.06] rounded px-2 py-1 text-xs text-[#F2F3F5] outline-none cursor-pointer"
              >
                <option value="">In range of all tabs</option>
                {SIM_POSITIONS.map((n) => (
                  <option key={n} value={n}>
                    Position {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-[#6D737F] leading-snug">
              Tabs only reach tabs one position away. Put three tabs at 1, 2 and 3: messages from 1 reach 3 through 2.
            </p>
            <button
              onClick={onStopSim}
              className="w-full px-2 py-1 rounded text-[11px] font-semibold text-[#949BA4] bg-white/[0.04] hover:bg-[#F23F43]/15 hover:text-[#F23F43] transition cursor-pointer"
            >
              Stop simulation
            </button>
          </div>
        </section>
      )}

      {/* Stats */}
      <section className="mt-auto">
        <SectionTitle>This device</SectionTitle>
        <dl className="px-2 mt-1 grid grid-cols-2 gap-y-0.5 text-[10px] font-mono text-[#6D737F]">
          <dt>Links</dt>
          <dd className="text-right text-[#DBDEE1]">{state.links}</dd>
          <dt>Received</dt>
          <dd className="text-right text-[#DBDEE1]">{stats.received}</dd>
          <dt>Relayed</dt>
          <dd className="text-right text-[#DBDEE1]">{stats.relayed}</dd>
          <dt>Dropped</dt>
          <dd className="text-right text-[#DBDEE1]">{stats.dropped}</dd>
        </dl>
      </section>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold text-[#6D737F] uppercase tracking-wider px-2 py-1">{children}</div>
  );
}
