"use client";

import { useEffect } from "react";
import { formatFingerprint } from "@/lib/mesh/identity";

interface Props {
  name: string;
  theirFingerprint: string;
  myFingerprint: string;
  verified: boolean;
  onVerify: (verified: boolean) => void;
  onClose: () => void;
}

/**
 * Compare fingerprints in person (docs/10 C6). If both phones show the same pair of codes, nobody
 * is pretending to be the other person. Scanning each other's code as a QR comes later (it
 * needs a camera plugin).
 */
export default function FingerprintDialog({ name, theirFingerprint, myFingerprint, verified, onVerify, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fingerprint-title"
        className="w-full max-w-sm bg-[#12141A] border border-white/[0.08] rounded-xl p-5 shadow-2xl"
      >
        <h2 id="fingerprint-title" className="text-base font-bold text-white tracking-tight break-words">
          Check it&apos;s really {name}
        </h2>
        <p className="text-[12px] text-[#949BA4] mt-1 leading-relaxed">
          Meet in person and compare these codes on both phones. If they match, nobody is pretending to be either of
          you.
        </p>
        <div className="mt-4 space-y-3">
          <Code label={`${name}'s code`} value={theirFingerprint} />
          <Code label="Your code" value={myFingerprint} />
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <span className={`text-[12px] font-semibold ${verified ? "text-[#23A55A]" : "text-[#949BA4]"}`}>
            {verified ? "✓ Verified" : "Not verified yet"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-[#F2F3F5] text-xs font-semibold rounded-md transition cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={() => onVerify(!verified)}
              className={`px-3 py-2 text-xs font-semibold rounded-md transition cursor-pointer ${
                verified
                  ? "bg-white/[0.06] hover:bg-[#F23F43]/15 text-[#949BA4] hover:text-[#F23F43]"
                  : "bg-[#23A55A] hover:bg-[#1F944F] text-white"
              }`}
            >
              {verified ? "Remove verification" : "Codes match"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Code({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-[#949BA4] uppercase tracking-wider">{label}</div>
      <div className="mt-1 px-3 py-2 rounded-md bg-[#1E212D] border border-white/[0.06] font-mono text-lg text-white tracking-wider text-center">
        {formatFingerprint(value)}
      </div>
    </div>
  );
}
