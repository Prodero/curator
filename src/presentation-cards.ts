import { randomUUID } from 'node:crypto';

/** Ephemeral presentation only. Never group by project or MCP connection alone:
 * both may be shared by independent conversations. */
export function createPresentationCards(limit = 1024) {
  const cards = new Map<string, { group: string; order: number }>();
  const latest = new Map<string, number>();
  let order = 0;
  return {
    issue(root: string, group: string) {
      const id = randomUUID();
      cards.set(id, { group: JSON.stringify([root, group]), order: ++order });
      while (cards.size > limit) {
        const oldest = cards.keys().next().value!;
        const removed = cards.get(oldest)!;
        cards.delete(oldest);
        if (![...cards.values()].some(card => card.group === removed.group)) latest.delete(removed.group);
      }
      return { id };
    },
    inspect(id: string, activate = false) {
      const card = cards.get(id);
      if (!card) return { available: false, superseded: false };
      // A late mount or a restored old card must not become the newest card.
      if (activate) latest.set(card.group, Math.max(latest.get(card.group) ?? 0, card.order));
      return { available: true, superseded: (latest.get(card.group) ?? 0) > card.order };
    },
  };
}
