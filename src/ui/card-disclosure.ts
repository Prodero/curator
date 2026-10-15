import { PRODERO_TOOLS } from '../contracts.js';

type CardState = { available: boolean; superseded: boolean };
type Environment = {
  inspect: (id: string, activate: boolean) => Promise<CardState>;
  display: (collapsed: boolean) => void;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
  visible: () => boolean;
};

/** One instance per iframe. Disclosures never replace the rendered content. */
export function createCardDisclosure(env: Environment) {
  let id: string | undefined, timer: unknown, generation = 0;
  let collapsed = true, stopped = true, failures = 0, activated = false, initialized = false;
  const cancel = () => { if (timer !== undefined) env.cancel(timer); timer = undefined; };
  const display = (value: boolean) => { collapsed = value; env.display(value); };
  async function inspect(request: number) {
    if (request !== generation || !id || stopped) return;
    try {
      const state = await env.inspect(id, !activated);
      if (request !== generation) return;
      const first = !activated;
      activated = true; failures = 0;
      if (!state.available) { stopped = true; return; }
      if (state.superseded) { stopped = true; display(true); return; }
      if (first) display(false);
    } catch {
      if (request !== generation) return;
      // Old servers, disconnections and unsupported App calls leave manual controls usable.
      if (++failures >= 3) { stopped = true; return; }
    }
    if (request === generation && !stopped && env.visible()) timer = env.schedule(() => { timer = undefined; void inspect(request); }, 4000 * Math.max(1, failures));
  }
  return {
    adopt(next: string | undefined) {
      if (initialized && id === next) return;
      initialized = true;
      cancel(); generation++; id = next; stopped = !id; failures = 0; activated = false;
      // Ungrouped Open responses have no card identity to inspect. Show their
      // content immediately; only coordinated history needs confirmation.
      display(Boolean(id)); void inspect(generation);
    },
    toggle() { initialized = true; cancel(); generation++; stopped = true; display(!collapsed); },
    visibilityChanged() {
      cancel(); generation++;
      // Reconcile once even while hidden, but only a newer card can collapse this one.
      void inspect(generation);
    },
    dispose() { cancel(); generation++; stopped = true; },
  };
}

export function mountCardDisclosure(
  call: (request: {name: string; arguments: Record<string, unknown>}) => Promise<any>,
  resize?: (size: {height: number}) => Promise<void>,
) {
  const frame = document.querySelector<HTMLElement>('#card-disclosure');
  const button = document.querySelector<HTMLButtonElement>('#card-toggle');
  const content = document.querySelector<HTMLElement>('#card-content');
  const title = document.querySelector<HTMLElement>('#card-title');
  const label = document.querySelector<HTMLElement>('#card-toggle-label');
  if (!frame || !button || !content || !title || !label) return;
  const controller = createCardDisclosure({
    inspect: async (id, activate) => {
      const result = await call({name: PRODERO_TOOLS.uiCardState, arguments: {cardId: id, activate}});
      if (result.isError || typeof result.structuredContent?.available !== 'boolean' || typeof result.structuredContent?.superseded !== 'boolean') throw new Error('Card state unavailable');
      return result.structuredContent;
    },
    display(collapsed) {
      if (collapsed && content.contains(document.activeElement)) button.focus({preventScroll: true});
      content.hidden = collapsed;
      button.setAttribute('aria-expanded', String(!collapsed));
      label.textContent = collapsed ? 'Expand' : 'Collapse';
      // Report the actual content height, independent of the host iframe viewport.
      // Keep the SDK observer for subsequent content changes and width changes.
      if (resize) void resize({height: Math.ceil((collapsed ? frame : document.body).getBoundingClientRect().height)}).catch(() => {});
    },
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: timer => window.clearTimeout(timer as number),
    visible: () => document.visibilityState !== 'hidden',
  });
  button.addEventListener('click', () => controller.toggle());
  document.addEventListener('visibilitychange', () => controller.visibilityChanged());
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
    const heading = content.querySelector('h1')?.textContent;
    if (heading) title.textContent = heading;
  });
  observer?.observe(content, {childList: true, subtree: true});
  const dispose = () => { controller.dispose(); observer?.disconnect(); };
  window.addEventListener('pagehide', dispose);
  let current: string | undefined;
  return {
    present(payload: any, heading: string) {
      const text = payload?.presentation?.resolved === 'text';
      frame.hidden = text;
      title.textContent = heading.replace(/^Prodero\s*·\s*/i, '');
      if (text) { controller.dispose(); content.hidden = false; return; }
      // In-place navigation often returns no new card identity. Keep the current disclosure.
      const next = payload?.presentation?.card?.id;
      if (typeof next === 'string' && next !== current) { current = next; controller.adopt(next); }
      else if (!current) controller.adopt(undefined);
    },
    dispose,
  };
}
