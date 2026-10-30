"use client";

import { useEffect, useState } from "react";
import { formatFingerprint } from "@/lib/mesh/identity";
import type { MeshSessionState } from "@/lib/mesh/meshSession";
import { avatarColor, hopLabel } from "./meshUi";

interface Props {
  state: MeshSessionState;
  onNickname: (name: string) => void;
  onSimPosition: (position: number | null) => void;
  onStopSim: () => void;
  onBridge: (enabled: boolean) => void;
  onDirect: (peerKey: string) => void;
  onWipe: () => void;
}

const SIM_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function MeshSidebar({ state, onNickname, onSimPosition, onStopSim, onBridge, onDirect, onWipe }: Props) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  useEffect(() => {
    if (!confirmWipe) return;
    const t = setTimeout(() => setConfirmWipe(false), 5000);
    return () => clearTimeout(t);
  }, [confirmWipe]);
  const { me, peers, stats, mode } = state;

  return (
    <aside className="w-60 bg-surface-1 border-l border-white/[0.04] p-3 overflow-y-auto shrink-0 hidden lg:flex flex-col gap-5">
      {/* This device */}
      {me && (
        <section>
          <SectionTitle>You</SectionTitle>
          <div className="px-2 mt-1 space-y-2">
            <label className="block">
              <span className="text-[10px] text-muted">Name shown to others</span>
              <input
                key={me.nickname}
                defaultValue={me.nickname}
                maxLength={32}
                onBlur={(e) => onNickname(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="mt-0.5 w-full bg-surface-3 border border-white/[0.06] focus:border-white/[0.18] rounded px-2 py-1 text-xs text-ink outline-none"
              />
            </label>
            <div>
              <span className="text-[10px] text-muted">Your fingerprint</span>
              <div className="text-[11px] text-body font-mono mt-0.5">{formatFingerprint(me.fingerprint)}</div>
              <p className="text-[10px] text-muted mt-1 leading-snug">
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
          <p className="px-2 mt-1 text-[11px] text-muted">
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
                    className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-1 ${
                      p.direct ? "bg-ok" : "bg-warn"
                    }`}
                  />
                </div>
                <div className="truncate flex-1">
                  <div className="text-xs font-medium text-body truncate">{p.nickname}</div>
                  <div className="text-[10px] text-muted font-mono">
                    #{p.fingerprint.slice(0, 4)} · {hopLabel(p.hops)}
                  </div>
                </div>
                <button
                  onClick={() => onDirect(p.key)}
                  aria-label={`Message ${p.nickname}`}
                  title={`Message ${p.nickname}`}
                  className="shrink-0 p-1 rounded text-muted hover:text-white hover:bg-white/[0.06] cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h16v11H8l-4 4V5z" />
                  </svg>
                </button>
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
              <span className="text-[10px] text-muted">This tab&apos;s position</span>
              <select
                value={state.simPosition ?? ""}
                onChange={(e) => onSimPosition(e.target.value === "" ? null : Number(e.target.value))}
                className="mt-0.5 w-full bg-surface-3 border border-white/[0.06] rounded px-2 py-1 text-xs text-ink outline-none cursor-pointer"
              >
                <option value="">In range of all tabs</option>
                {SIM_POSITIONS.map((n) => (
                  <option key={n} value={n}>
                    Position {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[10px] text-muted leading-snug">
              Tabs only reach tabs one position away. Put three tabs at 1, 2 and 3: messages from 1 reach 3 through 2.
            </p>
            <button
              onClick={onStopSim}
              className="w-full px-2 py-1 rounded text-[11px] font-semibold text-dim bg-white/[0.04] hover:bg-danger/15 hover:text-danger transition cursor-pointer"
            >
              Stop simulation
            </button>
          </div>
        </section>
      )}

      {/* Internet bridge */}
      {state.bridgeAvailable && (
        <section>
          <SectionTitle>Internet bridge</SectionTitle>
          <div className="px-2 mt-1 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] text-body">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    state.bridge === "up" ? "bg-ok" : state.bridge === "connecting" ? "bg-warn" : "bg-muted"
                  }`}
                />
                {!state.bridgeEnabled
                  ? "Off"
                  : state.bridge === "up"
                    ? "Connected"
                    : state.bridge === "connecting"
                      ? "Connecting…"
                      : "No internet"}
              </span>
              <button
                onClick={() => onBridge(!state.bridgeEnabled)}
                className="px-2 py-0.5 rounded text-[10px] font-semibold text-dim bg-white/[0.04] hover:bg-white/[0.08] hover:text-body transition cursor-pointer"
              >
                {state.bridgeEnabled ? "Turn off" : "Turn on"}
              </button>
            </div>
            <p className="text-[10px] text-muted leading-snug">
              Carries 🌐 channels between groups far apart whenever this phone has internet. The server sees your IP
              address, your key and channel tags, but never what locked channels say.
            </p>
          </div>
        </section>
      )}

      {/* Stats */}
      <section className="mt-auto">
        <SectionTitle>This device</SectionTitle>
        <button
          onClick={() => {
            if (!confirmWipe) return setConfirmWipe(true);
            setConfirmWipe(false);
            onWipe();
          }}
          className={`mx-2 mb-2 w-[calc(100%-1rem)] px-2 py-1 rounded text-[11px] font-semibold transition cursor-pointer ${
            confirmWipe
              ? "bg-danger text-on-danger"
              : "text-dim bg-white/[0.04] hover:bg-danger/15 hover:text-danger"
          }`}
          title="Deletes all mesh messages, channels, keys and your identity on this device"
        >
          {confirmWipe ? "Tap again to wipe everything" : "Wipe mesh data"}
        </button>
        <dl className="px-2 mt-1 grid grid-cols-2 gap-y-0.5 text-[10px] font-mono text-muted">
          <dt>Links</dt>
          <dd className="text-right text-body">{state.links}</dd>
          <dt>Received</dt>
          <dd className="text-right text-body">{stats.received}</dd>
          <dt>Relayed</dt>
          <dd className="text-right text-body">{stats.relayed}</dd>
          <dt>Dropped</dt>
          <dd className="text-right text-body">{stats.dropped}</dd>
          <dt>Power</dt>
          <dd className="text-right text-body">
            {state.power === "low" ? "low battery" : state.power === "background" ? "background" : state.power ? "normal" : "—"}
          </dd>
          <dt>Keys</dt>
          <dd className="text-right text-body" title="Whether this device's mesh keys are sealed with the phone's secure key store">
            {state.keysProtected ? "device-sealed" : "not sealed"}
          </dd>
        </dl>
        {state.power === "low" && (
          <p className="px-2 mt-1 text-[10px] text-muted leading-snug">
            Battery is low: scanning less, fewer links, and not carrying messages for channels you&apos;re not in.
          </p>
        )}
      </section>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold text-muted uppercase tracking-wider px-2 py-1">{children}</div>
  );
}
