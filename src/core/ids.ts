import crypto from "node:crypto";

export function sortableId(prefix: "sess" | "obs" | "mem" | "chk" | "skill", now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${prefix}_${stamp}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
