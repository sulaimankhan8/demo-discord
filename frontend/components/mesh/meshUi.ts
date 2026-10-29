// Small display helpers for the mesh UI (kept separate from ChatBox on purpose).

const AVATAR_COLORS = ["#5865F2", "#23A55A", "#F0B232", "#F23F43", "#9B59B6", "#1ABC9C"];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function hopLabel(hops: number): string {
  if (hops <= 0) return "sent";
  if (hops === 1) return "direct";
  return `${hops} hops`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? `Today at ${time}` : `${date.toLocaleDateString()} ${time}`;
}

export const MESH_ACCENT = "#F0B232";

export function kindLabel(kind: number): string {
  return ["", "Public", "Password", "Private", "Hidden"][kind] ?? "Channel";
}

/** "just now", "5 min ago", "2 h ago". */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const min = Math.floor((now - timestamp) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}
