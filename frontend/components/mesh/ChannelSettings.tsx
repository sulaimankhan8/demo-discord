"use client";

import { useEffect, useState } from "react";
import { ChannelKind } from "@/lib/mesh/channels/manifest";
import { Role } from "@/lib/mesh/channels/membership";
import type { MeshChannelInfo, MeshChannelMember, MeshPeer } from "@/lib/mesh/MeshService";
import { kindLabel, timeAgo } from "./meshUi";

export interface ChannelAdminActions {
  approve: (id: string, key: string) => void;
  decline: (id: string, key: string) => void;
  remove: (id: string, key: string) => void;
  setRole: (id: string, key: string, role: number) => void;
  rotate: (id: string) => void;
  invite: (id: string) => string | null;
}

interface Props {
  channel: MeshChannelInfo;
  myFingerprint: string;
  peers: MeshPeer[];
  admin: ChannelAdminActions;
  onLeave: () => void;
  onClose: () => void;
}

const ROLE_NAMES: Record<number, string> = {
  [Role.Member]: "Member",
  [Role.Admin]: "Admin",
  [Role.CoOwner]: "Co-owner",
  [Role.Owner]: "Owner",
};

const HISTORY_TEXT = ["recent messages", "only messages after they join", "everything kept"];

/** Roles I may give this member (empty = I can't change their role). Mirrors membership.ts. */
function roleChoices(mine: Role | undefined, target: Role): Role[] {
  if (mine === Role.Owner && target !== Role.Owner) return [Role.Member, Role.Admin, Role.CoOwner];
  if (mine === Role.CoOwner && target <= Role.Admin) return [Role.Member, Role.Admin];
  return [];
}

function canRemove(mine: Role | undefined, target: Role): boolean {
  if (mine === Role.Owner) return target !== Role.Owner;
  if (mine === Role.CoOwner) return target <= Role.Admin;
  if (mine === Role.Admin) return target === Role.Member;
  return false;
}

export default function ChannelSettings({ channel, myFingerprint, peers, admin, onLeave, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isAdmin = (channel.myRole ?? -1) >= Role.Admin;
  const names = new Map(peers.map((p) => [p.key, p.nickname]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (fn: () => void) => {
    setError(null);
    try {
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };

  const nameOf = (m: { key: string; fingerprint: string }) =>
    m.fingerprint === myFingerprint ? "You" : (names.get(m.key) ?? `#${m.fingerprint.slice(0, 4)}`);

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-settings-title"
        className="w-full max-w-lg max-h-full overflow-y-auto bg-[#12141A] border border-white/[0.08] rounded-xl p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="channel-settings-title" className="text-base font-bold text-white tracking-tight break-words">
              🔒 #{channel.name}
            </h2>
            <p className="text-[12px] text-[#949BA4] mt-0.5">
              {kindLabel(channel.kind)} · key #{channel.epoch ?? 0} · new members see{" "}
              {HISTORY_TEXT[channel.historyPolicy] ?? "recent messages"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-1 rounded text-[#949BA4] hover:text-white hover:bg-white/[0.06] cursor-pointer"
          >
            <svg className="w-4 h-4 fill-none stroke-current" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-[#F23F43]">
            {error}
          </p>
        )}

        {channel.waitingForApproval && (
          <p className="mt-4 px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.06] text-[12px] text-[#949BA4]">
            Your request to join has been sent. An admin needs to let you in; it&apos;s sent again whenever you meet
            new phones, for 12 hours.
          </p>
        )}

        {isAdmin && (
          <Section title={`Join requests — ${channel.joinRequests?.length ?? 0}`}>
            {!channel.joinRequests?.length ? (
              <p className="text-[11px] text-[#6D737F]">Nobody is waiting.</p>
            ) : (
              <ul className="space-y-1.5">
                {channel.joinRequests.map((r) => (
                  <li key={r.key} className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/[0.03]">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-[#DBDEE1] truncate">
                        {names.get(r.key) ?? "Someone"} <span className="font-mono text-[#6D737F]">#{r.fingerprint.slice(0, 4)}</span>
                      </div>
                      <div className="text-[10px] text-[#6D737F] truncate">
                        {r.note ? `“${r.note}” · ` : ""}
                        {timeAgo(r.at)}
                      </div>
                    </div>
                    <button
                      onClick={() => run(() => admin.approve(channel.id, r.key))}
                      className="px-2 py-1 rounded text-[11px] font-semibold bg-[#23A55A] hover:bg-[#1F944F] text-white cursor-pointer"
                    >
                      Let in
                    </button>
                    <button
                      onClick={() => run(() => admin.decline(channel.id, r.key))}
                      className="px-2 py-1 rounded text-[11px] font-semibold bg-white/[0.06] hover:bg-white/[0.1] text-[#DBDEE1] cursor-pointer"
                    >
                      Decline
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[10px] text-[#6D737F] leading-snug">
              Compare the #code with the person&apos;s fingerprint before letting them in.
            </p>
          </Section>
        )}

        <Section title={`Members — ${channel.members?.length ?? 0}`}>
          <ul className="space-y-1">
            {(channel.members ?? []).map((m: MeshChannelMember) => {
              const isMe = m.fingerprint === myFingerprint;
              const choices = isMe ? [] : roleChoices(channel.myRole, m.role);
              return (
                <li key={m.key} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/[0.03]">
                  <div className="min-w-0 flex-1">
                    <span className="text-xs text-[#DBDEE1]">{nameOf(m)}</span>
                    <span className="ml-1.5 text-[10px] font-mono text-[#6D737F]">#{m.fingerprint.slice(0, 4)}</span>
                  </div>
                  {choices.length > 0 ? (
                    <select
                      aria-label={`Role of ${nameOf(m)}`}
                      value={m.role}
                      onChange={(e) => run(() => admin.setRole(channel.id, m.key, Number(e.target.value)))}
                      className="bg-[#1E212D] border border-white/[0.06] rounded px-1.5 py-0.5 text-[11px] text-[#F2F3F5] outline-none cursor-pointer"
                    >
                      {choices.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_NAMES[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[10px] text-[#949BA4]">{ROLE_NAMES[m.role]}</span>
                  )}
                  {!isMe && canRemove(channel.myRole, m.role) && (
                    <button
                      onClick={() => run(() => admin.remove(channel.id, m.key))}
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#949BA4] hover:bg-[#F23F43]/15 hover:text-[#F23F43] cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] text-[#6D737F] leading-snug">
            Removing someone moves everyone else to a new key, so they can&apos;t read anything new.
          </p>
        </Section>

        {isAdmin && (
          <Section title="Invite">
            {invite ? (
              <>
                <textarea
                  readOnly
                  value={invite}
                  onFocus={(e) => e.target.select()}
                  rows={4}
                  aria-label="Invite text"
                  className="w-full bg-[#1E212D] border border-white/[0.06] rounded px-2 py-1.5 text-[10px] font-mono text-[#DBDEE1] outline-none break-all resize-none"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    onClick={() => void copy()}
                    className="px-3 py-1 rounded text-[11px] font-semibold bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] cursor-pointer"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <span className="text-[10px] text-[#6D737F]">Lets one person in. Works for 7 days.</span>
                </div>
              </>
            ) : (
              <button
                onClick={() =>
                  run(() => {
                    setInvite(admin.invite(channel.id));
                    setCopied(false);
                  })
                }
                className="px-3 py-1.5 rounded text-[11px] font-semibold bg-white/[0.06] hover:bg-white/[0.1] text-[#F2F3F5] cursor-pointer"
              >
                Create invite
              </button>
            )}
            <p className="mt-1.5 text-[10px] text-[#6D737F] leading-snug">
              {channel.kind === ChannelKind.Hidden
                ? "Hidden channels aren't listed nearby, so an invite is the only way in. "
                : ""}
              Send it however you like (it&apos;s text). Whoever pastes it is let in by any admin, no approval needed.
            </p>
          </Section>
        )}

        <Section title="Key">
          <p className="text-[11px] text-[#949BA4] leading-snug">
            The key changes every 24 hours, after 500 messages, and whenever someone leaves or is removed.
          </p>
          {isAdmin && (
            <button
              onClick={() => run(() => admin.rotate(channel.id))}
              className="mt-1.5 px-3 py-1.5 rounded text-[11px] font-semibold bg-white/[0.06] hover:bg-white/[0.1] text-[#F2F3F5] cursor-pointer"
            >
              Change key now
            </button>
          )}
        </Section>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onLeave}
            className="px-4 py-2 rounded-md text-xs font-semibold text-[#F23F43] bg-[#F23F43]/10 hover:bg-[#F23F43]/20 cursor-pointer"
          >
            Leave channel
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider mb-1.5">{title}</h3>
      {children}
    </section>
  );
}
