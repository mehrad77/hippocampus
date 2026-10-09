import { ICONS, type IconName } from "../lib/icons.ts";

export function Icon({ name, size = 20, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      <path d={ICONS[name]} />
    </svg>
  );
}
