"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useMesh } from "@/hooks/useMesh";
import { isSimRemembered } from "@/lib/mesh/meshSession";
import { ChannelKind } from "@/lib/mesh/channels/manifest";
import { Role } from "@/lib/mesh/channels/membership";
import ChannelSettings from "./ChannelSettings";
import FingerprintDialog from "./FingerprintDialog";
import CreateChannelDialog from "./CreateChannelDialog";
import InviteJoinDialog from "./InviteJoinDialog";
import JoinPasswordDialog from "./JoinPasswordDialog";
import MeshChannelList from "./MeshChannelList";
import MeshComposer from "./MeshComposer";
import MeshIcon from "@/components/icons/MeshIcon";
import MeshMessageList from "./MeshMessageList";
import MeshSidebar from "./MeshSidebar";
import { kindLabel, MESH_ACCENT } from "./meshUi";

const LOBBY_DESCRIPTION =
  "Messages here go phone to phone with no internet. Phones in range pass them on, up to 7 hops. Anyone nearby can read this room. It keeps the last hour.";

function retentionText(hours: number): string {
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export default function MeshRoom() {
  const {
    state,
    native,
    start,
    stop,
    restart,
    enableBluetooth,
    send,
    setNickname,
    setSimPosition,
    createChannel,
    joinChannel,
    joinWithInvite,
    channelAdmin,
    leaveChannel,
    setActiveChannel,
    setBridgeEnabled,
    openDirect,
    setContactVerified,
    panicWipe,
  } = useMesh();
  const [verifying, setVerifying] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  /** Nearby password channel waiting for its password. */
  const [joining, setJoining] = useState<{ id: string; name: string } | null>(null);

  // The mesh only runs while this page is open (see docs/08 §12).
  useEffect(() => {
    if (native) void start("ble");
    else if (isSimRemembered()) void start("sim");
    return () => {
      void stop();
    };
  }, [native, start, stop]);

  const running = state.status === "running";
  const channel = state.activeChannel;
  const direct = state.activeDirect;
  const title = channel ? channel.name : direct ? direct.nickname : "nearby";
  const description = channel
    ? `${channel.description ? `${channel.description} · ` : ""}${kindLabel(channel.kind)} channel by #${channel.ownerFingerprint.slice(0, 4)}. ${
        channel.kind === ChannelKind.Password
          ? "Messages are encrypted: only people with the password can read them. Other phones pass them on without seeing what they say."
          : channel.kind === ChannelKind.Private || channel.kind === ChannelKind.Hidden
            ? "Messages are encrypted for members only; an admin lets people in. Other phones pass them on without seeing what they say, or even which channel they're for."
            : "Anyone nearby can join and read it."
      } Members' phones keep ${retentionText(channel.retentionHours)} of messages and pass them to new members.`
    : direct
      ? `Only ${direct.nickname} can read what you send here. Phones in between pass it on without seeing what it says. If ${direct.nickname} is out of range, it's sent again whenever you meet new phones, for 12 hours.${
          direct.verified ? "" : " Compare fingerprints in person (Verify) to be sure it's really them."
        }`
      : LOBBY_DESCRIPTION;
  const showList = !!state.mode && state.status !== "error";
  const isPrivate = !!channel && (channel.kind === ChannelKind.Private || channel.kind === ChannelKind.Hidden);
  const requests = channel?.joinRequests?.length ?? 0;
  const notice = !channel
    ? undefined
    : channel.waitingForApproval
      ? "Request sent. You'll see the messages once an admin lets you in (it's sent again to every new phone you meet)."
      : requests > 0
        ? `${requests} ${requests === 1 ? "person wants" : "people want"} to join. Open Members to let them in.`
        : undefined;
  const unreadElsewhere =
    (state.activeChannelId === "" ? 0 : state.lobbyUnread) +
    state.channels.reduce((n, c) => n + (c.id === state.activeChannelId ? 0 : c.unread), 0) +
    state.directs.reduce((n, d) => n + (d.id === state.activeChannelId ? 0 : d.unread), 0);

  const channelList = (
    <MeshChannelList
      channels={state.channels}
      nearby={state.nearbyChannels}
      activeId={state.activeChannelId}
      lobbyUnread={state.lobbyUnread}
      running={running}
      bridgeUp={state.bridge === "up"}
      onSelect={(id) => {
        setActiveChannel(id);
        setShowChannels(false);
      }}
      onJoin={(id) => {
        const c = state.nearbyChannels.find((x) => x.id === id);
        setShowChannels(false);
        if (c?.kind === ChannelKind.Password) setJoining({ id, name: c.name });
        else void joinChannel(id);
      }}
      onCreate={() => setCreating(true)}
      onInvite={() => {
        setShowChannels(false);
        setInviting(true);
      }}
      directs={state.directs}
      peers={state.peers}
      onDirect={(key) => {
        openDirect(key);
        setShowChannels(false);
      }}
    />
  );

  return (
    <AppShell activeChannel="nearby" allowOffline>
      <div className="relative flex h-full w-full overflow-hidden bg-[#171922] font-sans">
        {showList && (
          <aside className="w-56 bg-[#12141A] border-r border-white/[0.04] shrink-0 hidden md:block">{channelList}</aside>
        )}
        {showList && showChannels && (
          // Fixed, not absolute: on phones the app shell's rails leave this page very little width.
          <div className="md:hidden fixed inset-0 z-40 flex">
            <aside className="w-64 max-w-[80%] bg-[#12141A] border-r border-white/[0.06] shadow-2xl">{channelList}</aside>
            <button
              aria-label="Close channel list"
              className="flex-1 bg-black/50 cursor-default"
              onClick={() => setShowChannels(false)}
            />
          </div>
        )}
        <div className="flex-1 flex flex-col h-full min-w-0 bg-[#171922]">
          <header className="h-12 px-4 border-b border-white/[0.05] bg-[#171922] flex items-center justify-between shrink-0 z-10">
            <div className="flex items-center gap-2 min-w-0">
              {showList && (
                <button
                  onClick={() => setShowChannels(true)}
                  aria-label="Show channels"
                  className="md:hidden relative -ml-1 p-1 rounded text-[#949BA4] hover:text-white hover:bg-white/[0.06] cursor-pointer"
                >
                  <svg className="w-5 h-5 fill-none stroke-current" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                  {unreadElsewhere > 0 && <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-[#F23F43]" />}
                </button>
              )}
              <span style={{ color: MESH_ACCENT }}>
                <MeshIcon className="w-4 h-4" />
              </span>
              <h2 className="font-semibold text-sm text-white tracking-tight truncate">
                {direct ? `@${title}` : title}
              </h2>
              {direct && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#949BA4] font-mono">
                  #{direct.fingerprint.slice(0, 4)}
                  {direct.verified ? " · ✓ verified" : ""}
                </span>
              )}
              {channel && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#949BA4] font-mono">
                  {kindLabel(channel.kind).toLowerCase()} · #{channel.ownerFingerprint.slice(0, 4)}
                  {channel.role === "owner" ? " (you)" : ""}
                </span>
              )}
              <div className="h-4 w-[1px] bg-white/[0.08] mx-2 hidden sm:block" />
              <span className="text-xs text-[#949BA4] truncate hidden sm:block font-mono">
                {state.mode === "sim"
                  ? "Offline mesh · browser-tab simulation"
                  : state.mode === "ble"
                    ? "Offline mesh · Bluetooth"
                    : "Offline mesh · no internet needed"}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {direct && (
                <button
                  onClick={() => setVerifying(true)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold text-[#DBDEE1] bg-white/[0.06] hover:bg-white/[0.1] transition cursor-pointer"
                >
                  {direct.verified ? "Fingerprint" : "Verify"}
                </button>
              )}
              {isPrivate && (
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="relative px-2.5 py-1 rounded-md text-[11px] font-semibold text-[#DBDEE1] bg-white/[0.06] hover:bg-white/[0.1] transition cursor-pointer"
                >
                  Members
                  {requests > 0 && (
                    <span className="ml-1.5 inline-flex min-w-[16px] h-4 px-1 rounded-full bg-[#F23F43] text-white text-[10px] font-bold items-center justify-center">
                      {requests}
                    </span>
                  )}
                </button>
              )}
              {channel && !isPrivate && (
                <button
                  onClick={() => leaveChannel(channel.id)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold text-[#949BA4] bg-white/[0.04] hover:bg-[#F23F43]/15 hover:text-[#F23F43] transition cursor-pointer"
                >
                  Leave
                </button>
              )}
              {state.mode && (
                <StatusPill
                  links={state.links}
                  running={running}
                  relayed={state.stats.relayed}
                  lowPower={state.power === "low"}
                />
              )}
            </div>
          </header>

          {state.status === "idle" && !native ? (
            <Intro onStart={() => void start("sim")} />
          ) : state.status === "error" ? (
            <Notice title="Mesh couldn't start" body={state.error ?? "Unknown error."}>
              {state.errorCode === "bluetooth_off" && (
                <button
                  onClick={() => void enableBluetooth()}
                  className="px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
                >
                  Turn on Bluetooth
                </button>
              )}
              {state.errorCode !== "unsupported" && (
                <button
                  onClick={() => void restart()}
                  className="px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-[#F2F3F5] text-xs font-semibold rounded-md transition cursor-pointer"
                >
                  Try again
                </button>
              )}
            </Notice>
          ) : (
            <>
              {state.notice && (
                <div className="mx-4 mt-3 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[#F0B232]/30 bg-[#F0B232]/10 text-[12px] text-[#F0B232]">
                  <span>{state.notice.message}</span>
                  {state.notice.code === "bluetooth_off" && (
                    <button
                      onClick={() => void enableBluetooth()}
                      className="shrink-0 px-2.5 py-1 rounded bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-[11px] font-semibold transition cursor-pointer"
                    >
                      Turn on
                    </button>
                  )}
                </div>
              )}
              <MeshMessageList
                messages={state.messages}
                title={title}
                description={description}
                waitingForKey={channel?.waitingForKey ?? 0}
                notice={notice}
              />
              <MeshComposer
                disabled={!running || (!!channel && !channel.canSend)}
                onSend={send}
                placeholder={
                  channel && !channel.canSend
                    ? channel.waitingForApproval
                      ? "Waiting for an admin to let you in…"
                      : "Waiting for the channel key…"
                    : channel
                      ? `Message #${channel.name}`
                      : direct
                        ? `Message @${direct.nickname} (only they can read it)`
                        : "Message phones nearby"
                }
              />
            </>
          )}
        </div>

        {state.mode && state.status !== "error" && (
          <MeshSidebar
            state={state}
            onNickname={setNickname}
            onSimPosition={setSimPosition}
            onStopSim={() => void stop({ forget: true })}
            onBridge={(on) => void setBridgeEnabled(on)}
            onDirect={(key) => openDirect(key)}
            onWipe={() => void panicWipe()}
          />
        )}
      </div>
      {creating && (
        <CreateChannelDialog
          onClose={() => setCreating(false)}
          onCreate={async (opts) => {
            await createChannel(opts);
            setCreating(false);
            setShowChannels(false);
          }}
        />
      )}
      {settingsOpen && channel && isPrivate && state.me && (
        <ChannelSettings
          channel={channel}
          myFingerprint={state.me.fingerprint}
          peers={state.peers}
          admin={channelAdmin}
          onLeave={() => {
            if (channel.myRole === Role.Owner && !window.confirm("You own this channel. Leave it anyway? It keeps running on members' phones.")) return;
            leaveChannel(channel.id);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {verifying && direct && state.me && (
        <FingerprintDialog
          name={direct.nickname}
          theirFingerprint={direct.fingerprint}
          myFingerprint={state.me.fingerprint}
          verified={direct.verified}
          onVerify={(v) => setContactVerified(direct.key, v)}
          onClose={() => setVerifying(false)}
        />
      )}
      {inviting && <InviteJoinDialog onJoin={(text) => joinWithInvite(text)} onClose={() => setInviting(false)} />}
      {joining && (
        <JoinPasswordDialog
          channelName={joining.name}
          onJoin={(password) => joinChannel(joining.id, password)}
          onClose={() => setJoining(null)}
        />
      )}
    </AppShell>
  );
}

function StatusPill({
  links,
  running,
  relayed,
  lowPower,
}: {
  links: number;
  running: boolean;
  relayed: number;
  lowPower: boolean;
}) {
  const connected = running && links > 0;
  return (
    <span
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border ${
        connected
          ? "bg-[#23A55A]/15 text-[#23A55A] border-[#23A55A]/30"
          : "bg-[#F0B232]/10 text-[#F0B232] border-[#F0B232]/30"
      }`}
      title={`${relayed} messages passed on for others${lowPower ? " · low battery: not carrying for others" : ""}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#23A55A]" : "bg-[#F0B232] animate-pulse"}`} />
      {!running ? "Starting…" : connected ? `${links} ${links === 1 ? "link" : "links"}` : "Searching…"}
      {running && relayed > 0 && <span className="font-mono font-normal opacity-80 hidden sm:inline">· ↻{relayed}</span>}
      {lowPower && <span title="Low battery mode">🔋</span>}
    </span>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#12141A] border border-white/[0.06] rounded-xl p-6">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center mb-4 bg-[#F0B232]/10 border border-[#F0B232]/30"
          style={{ color: MESH_ACCENT }}
        >
          <MeshIcon className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-white tracking-tight">Chat with no internet</h3>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">
          The offline mesh sends messages phone to phone over Bluetooth. Phones in range pass messages on, so it
          keeps working when mobile networks are down. It runs in the mobile app.
        </p>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">
          In the browser you can try it as a simulation: each tab acts as one phone. Open this page in two or three
          tabs.
        </p>
        <button
          onClick={onStart}
          className="mt-5 px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
        >
          Start simulation
        </button>
      </div>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#12141A] border border-white/[0.06] rounded-xl p-6">
        <h3 className="text-base font-bold text-white tracking-tight">{title}</h3>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">{body}</p>
        {children && <div className="mt-5 flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  );
}
