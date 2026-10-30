"use client";

import { ChannelKind } from "@/lib/mesh/channels/manifest";
import {
  LOBBY_TAG,
  type MeshChannelInfo,
  type MeshDirectInfo,
  type MeshNearbyChannel,
  type MeshPeer,
} from "@/lib/mesh/MeshService";
import { hopLabel, kindLabel, MESH_ACCENT, timeAgo } from "./meshUi";

interface Props {
  channels: MeshChannelInfo[];
  nearby: MeshNearbyChannel[];
  activeId: string;
  lobbyUnread: number;
  running: boolean;
  /** The internet bridge is connected: mark channels it carries. */
  bridgeUp?: boolean;
  onSelect: (id: string) => void;
  onJoin: (id: string) => void;
  onCreate: () => void;
  onInvite: () => void;
  directs: MeshDirectInfo[];
  peers: MeshPeer[];
  onDirect: (peerKey: string) => void;
}

export default function MeshChannelList({
  channels,
  nearby,
  activeId,
  lobbyUnread,
  running,
  bridgeUp,
  onSelect,
  onJoin,
  onCreate,
  onInvite,
  directs,
  peers,
  onDirect,
}: Props) {
  const talkedTo = new Set(directs.map((d) => d.key));
  const startable = peers.filter((p) => !talkedTo.has(p.key)).slice(0, 8);
  return (
    <nav aria-label="Mesh channels" className="flex flex-col gap-4 p-2 overflow-y-auto h-full">
      <section>
        <SectionTitle>Lobby</SectionTitle>
        <ChannelRow name="nearby" active={activeId === LOBBY_TAG} unread={lobbyUnread} onClick={() => onSelect(LOBBY_TAG)} />
      </section>

      <section>
        <div className="flex items-center justify-between pr-1">
          <SectionTitle>Your channels</SectionTitle>
          <button
            onClick={onCreate}
            disabled={!running}
            aria-label="Create channel"
            title="Create channel"
            className="w-5 h-5 flex items-center justify-center rounded text-dim hover:text-white hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
          >
            <svg className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        {channels.length === 0 ? (
          <p className="px-2 mt-0.5 text-[11px] text-muted leading-snug">
            None yet. Join one below or make your own with +.
          </p>
        ) : (
          <div className="space-y-px">
            {channels.map((c) => (
              <ChannelRow
                key={c.id}
                name={c.name}
                locked={c.kind !== ChannelKind.Public}
                bridged={!!bridgeUp && c.bridgeAllowed}
                active={activeId === c.id}
                unread={c.unread}
                onClick={() => onSelect(c.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Direct messages</SectionTitle>
        {directs.length === 0 && startable.length === 0 ? (
          <p className="px-2 mt-0.5 text-[11px] text-muted leading-snug">
            People nearby show up here. Only they can read what you send them.
          </p>
        ) : (
          <div className="space-y-px">
            {directs.map((d) => (
              <button
                key={d.id}
                onClick={() => onSelect(d.id)}
                aria-current={activeId === d.id ? "page" : undefined}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition cursor-pointer ${
                  activeId === d.id ? "bg-white/[0.08] text-white" : "text-dim hover:bg-white/[0.04] hover:text-body"
                }`}
              >
                <span className="text-sm leading-none">@</span>
                <span className={`text-[13px] truncate flex-1 ${d.unread > 0 && activeId !== d.id ? "font-semibold text-white" : "font-medium"}`}>
                  {d.nickname}
                </span>
                {d.verified && (
                  <span className="text-[10px] text-ok" title="Fingerprint checked in person">
                    ✓
                  </span>
                )}
                {d.unread > 0 && activeId !== d.id && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-on-danger text-[10px] font-bold flex items-center justify-center">
                    {d.unread > 99 ? "99+" : d.unread}
                  </span>
                )}
              </button>
            ))}
            {startable.map((p) => (
              <button
                key={p.key}
                onClick={() => onDirect(p.key)}
                disabled={!running}
                title={`Send ${p.nickname} a private message`}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-muted hover:bg-white/[0.04] hover:text-body disabled:opacity-40 transition cursor-pointer"
              >
                <span className="text-sm leading-none">+</span>
                <span className="text-[12px] truncate flex-1">{p.nickname}</span>
                <span className="text-[10px] font-mono">#{p.fingerprint.slice(0, 4)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Nearby — {nearby.length}</SectionTitle>
        {nearby.length === 0 ? (
          <p className="px-2 mt-0.5 text-[11px] text-muted leading-snug">
            Channels other phones are in show up here.
          </p>
        ) : (
          <div className="space-y-1">
            {nearby.map((c) => {
              const joinable = c.kind !== ChannelKind.Hidden;
              const canJoin = running && joinable;
              return (
                <div key={c.id} className="px-2 py-1.5 rounded bg-white/[0.02] border border-white/[0.04]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted text-sm leading-none">#</span>
                    <span className="text-xs font-medium text-body truncate flex-1">{c.name}</span>
                    {c.kind !== ChannelKind.Public && <span title={kindLabel(c.kind)}>🔒</span>}
                    <button
                      onClick={() => onJoin(c.id)}
                      disabled={!canJoin}
                      title={
                        c.kind === ChannelKind.Private ? `Ask to join #${c.name}` : joinable ? `Join #${c.name}` : "Join by invite"
                      }
                      className="shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold bg-warn hover:bg-warn-hover brut text-canvas disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
                    >
                      {c.kind === ChannelKind.Private ? "Ask" : "Join"}
                    </button>
                  </div>
                  {c.description && <p className="mt-0.5 text-[10px] text-dim line-clamp-2">{c.description}</p>}
                  <p className="mt-0.5 text-[10px] text-muted font-mono">
                    {hopLabel(c.hops)}
                    {c.lastActivity ? ` · active ${timeAgo(c.lastActivity)}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <button
        onClick={onInvite}
        disabled={!running}
        className="mx-2 mt-auto px-2 py-1.5 rounded text-[11px] font-semibold text-dim bg-white/[0.04] hover:bg-white/[0.08] hover:text-body disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
      >
        Join with an invite
      </button>
    </nav>
  );
}

function ChannelRow({
  name,
  active,
  unread,
  locked,
  bridged,
  onClick,
}: {
  name: string;
  active: boolean;
  unread: number;
  locked?: boolean;
  bridged?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left transition cursor-pointer ${
        active ? "bg-white/[0.08] text-white" : "text-dim hover:bg-white/[0.04] hover:text-body"
      }`}
    >
      <span className="text-sm leading-none" style={active ? { color: MESH_ACCENT } : undefined}>
        #
      </span>
      <span className={`text-[13px] truncate flex-1 ${unread > 0 && !active ? "font-semibold text-white" : "font-medium"}`}>
        {name}
      </span>
      {locked && <span className="text-[10px]">🔒</span>}
      {bridged && (
        <span className="text-[10px]" title="Also carried over the internet bridge">
          🌐
        </span>
      )}
      {unread > 0 && !active && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-on-danger text-[10px] font-bold flex items-center justify-center">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold text-muted uppercase tracking-wider px-2 py-1">{children}</div>;
}
