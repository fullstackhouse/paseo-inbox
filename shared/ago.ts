/** Compact age for a column: "now", "5m", "3h", "2d". */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Age for a sentence: "just now", "5m ago", "3h ago". */
export function agoText(iso: string, now = Date.now()): string {
  const age = ago(iso, now);
  return age === "now" ? "just now" : `${age} ago`;
}
