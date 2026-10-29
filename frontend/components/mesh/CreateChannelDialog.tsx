"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChannelKind,
  cleanChannelName,
  HistoryPolicy,
  MAX_CHANNEL_DESC_BYTES,
} from "@/lib/mesh/channels/manifest";
import { MIN_PASSWORD_LENGTH, type CreateChannelOptions } from "@/lib/mesh/MeshService";

interface Props {
  onCreate: (opts: CreateChannelOptions) => Promise<void>;
  onClose: () => void;
}

const KINDS: { kind: ChannelKind; label: string; hint: string; ready: boolean }[] = [
  { kind: ChannelKind.Public, label: "Public", hint: "Anyone nearby can find, join and read it.", ready: true },
  { kind: ChannelKind.Password, label: "Password", hint: "Listed nearby; reading needs the password.", ready: true },
  { kind: ChannelKind.Private, label: "Private", hint: "Listed nearby; an admin lets each person in.", ready: true },
  { kind: ChannelKind.Hidden, label: "Hidden", hint: "Not listed; people join with an invite you share.", ready: true },
];

const RETENTION = [
  { hours: 1, label: "1 hour" },
  { hours: 6, label: "6 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

export default function CreateChannelDialog({ onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ChannelKind>(ChannelKind.Public);
  const [historyPolicy, setHistoryPolicy] = useState<HistoryPolicy>(HistoryPolicy.Recent);
  const [retentionHours, setRetentionHours] = useState(24);
  const [ttl, setTtl] = useState(7);
  const [bridge, setBridge] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const slug = cleanChannelName(name);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const isPassword = kind === ChannelKind.Password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!slug) return setError("Give the channel a name.");
    if (isPassword && password.length < MIN_PASSWORD_LENGTH) {
      return setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (isPassword && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      await onCreate({
        name: slug,
        description,
        kind,
        historyPolicy,
        retentionHours,
        ttl,
        bridge,
        password: isPassword ? password : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the channel.");
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
        aria-labelledby="create-channel-title"
        onSubmit={submit}
        className="w-full max-w-md max-h-full overflow-y-auto bg-[#12141A] border border-white/[0.08] rounded-xl p-5 shadow-2xl"
      >
        <h2 id="create-channel-title" className="text-base font-bold text-white tracking-tight">
          Create a channel
        </h2>
        <p className="text-[12px] text-[#949BA4] mt-1 leading-relaxed">
          It lives on every member&apos;s phone, so it keeps working when you&apos;re out of range.
        </p>

        <label className="block mt-4">
          <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Name</span>
          <div className="mt-1 flex items-center bg-[#1E212D] border border-white/[0.06] focus-within:border-white/[0.18] rounded px-2.5">
            <span className="text-[#6D737F] text-sm">#</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={40}
              placeholder="team-north"
              className="w-full bg-transparent px-1.5 py-2 text-sm text-[#F2F3F5] placeholder-[#6D737F] outline-none"
            />
          </div>
          {name && slug !== name && (
            <span className="mt-1 block text-[10px] text-[#6D737F] font-mono">Will be #{slug || "…"}</span>
          )}
        </label>

        <label className="block mt-3">
          <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">
            Description <span className="normal-case font-normal text-[#6D737F]">(optional)</span>
          </span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_CHANNEL_DESC_BYTES}
            placeholder="What it's for"
            className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] focus:border-white/[0.18] rounded px-2.5 py-2 text-sm text-[#F2F3F5] placeholder-[#6D737F] outline-none"
          />
        </label>

        <fieldset className="mt-3">
          <legend className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Who can join</legend>
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {KINDS.map((k) => (
              <label
                key={k.kind}
                className={`flex items-start gap-2 p-2 rounded border transition ${
                  kind === k.kind ? "border-[#F0B232]/50 bg-[#F0B232]/[0.06]" : "border-white/[0.06]"
                } ${k.ready ? "cursor-pointer hover:border-white/[0.14]" : "opacity-45 cursor-not-allowed"}`}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k.kind}
                  disabled={!k.ready}
                  onChange={() => setKind(k.kind)}
                  className="mt-0.5 accent-[#F0B232]"
                />
                <span>
                  <span className="block text-xs font-semibold text-[#F2F3F5]">
                    {k.label}
                    {!k.ready && <span className="ml-1 font-normal text-[10px] text-[#6D737F]">soon</span>}
                  </span>
                  <span className="block text-[10px] text-[#949BA4] leading-snug">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {isPassword && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] focus:border-white/[0.18] rounded px-2.5 py-2 text-sm text-[#F2F3F5] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Repeat it</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError(null);
                }}
                className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] focus:border-white/[0.18] rounded px-2.5 py-2 text-sm text-[#F2F3F5] outline-none"
              />
            </label>
            <p className="sm:col-span-2 text-[10px] text-[#6D737F] leading-snug">
              Share it in person. Anyone with it can read the channel, and it can&apos;t be changed later. A long
              phrase is safest.
            </p>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">New members see</span>
            <select
              value={historyPolicy}
              onChange={(e) => setHistoryPolicy(Number(e.target.value) as HistoryPolicy)}
              className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] rounded px-2 py-2 text-xs text-[#F2F3F5] outline-none cursor-pointer"
            >
              <option value={HistoryPolicy.Recent}>Recent messages</option>
              <option value={HistoryPolicy.SinceJoin}>Only after joining</option>
              <option value={HistoryPolicy.Full}>Everything kept</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Keep messages</span>
            <select
              value={retentionHours}
              onChange={(e) => setRetentionHours(Number(e.target.value))}
              className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] rounded px-2 py-2 text-xs text-[#F2F3F5] outline-none cursor-pointer"
            >
              {RETENTION.map((r) => (
                <option key={r.hours} value={r.hours}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block col-span-2">
            <span className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">Reach</span>
            <select
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="mt-1 w-full bg-[#1E212D] border border-white/[0.06] rounded px-2 py-2 text-xs text-[#F2F3F5] outline-none cursor-pointer"
            >
              <option value={7}>Whole mesh (up to 7 phones away)</option>
              <option value={5}>Medium (5 phones away)</option>
              <option value={3}>Close by (3 phones away), less traffic</option>
            </select>
          </label>
        </div>

        <label className="mt-3 flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={bridge}
            onChange={(e) => setBridge(e.target.checked)}
            className="mt-0.5 accent-[#F0B232]"
          />
          <span>
            <span className="block text-xs font-semibold text-[#F2F3F5]">Also carry it over the internet</span>
            <span className="block text-[10px] text-[#949BA4] leading-snug">
              When a member&apos;s phone has internet, groups far apart share this channel through the app&apos;s
              server.{" "}
              {kind === ChannelKind.Public
                ? "Public channels aren't encrypted, so the server could read them."
                : "Messages stay encrypted; the server only sees that something was sent."}
            </span>
          </span>
        </label>

        {error && <p className="mt-3 text-[12px] text-[#F23F43]">{error}</p>}

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
            disabled={!slug || busy}
            className="px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] disabled:opacity-40 disabled:cursor-not-allowed text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
          >
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
      </form>
    </div>
  );
}
