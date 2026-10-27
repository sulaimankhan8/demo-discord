export default function MeshIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={`${className} fill-none stroke-current`} strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path strokeLinecap="round" d="M8.3 10.9l7.4-3.7M8.3 13.1l7.4 3.7M18 8.5v7" />
    </svg>
  );
}
