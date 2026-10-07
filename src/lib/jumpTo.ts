// A one-shot "open here" hint for the page about to be shown — e.g. All Notes sending you to
// Health → Sleep on the night a note was written, or to one movie. The destination reads it as
// it mounts. A page and the components inside it can each read the same hint (Finance picks the
// tab, the transactions grid picks the row).
export interface Jump {
  page: string;
  tab?: string;
  date?: string;
  /** The exact record, for pages that can open or point at one. */
  collection?: string;
  id?: string;
  /** Text to search for, where the page has a search box rather than an "open this" state. */
  search?: string;
}

let pending: Jump | null = null;
let clearTimer: number | undefined;

export function requestJump(jump: Jump): void {
  pending = jump;
  // Whatever doesn't get read as the destination mounts is dropped, so a stale hint can't fire
  // on some later, unrelated visit to the page.
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => { if (pending === jump) pending = null; }, 1500);
}

/** The pending hint for this page, if any. Reading doesn't consume it (see above). */
export function takeJump(page: string): Jump | null {
  return pending && pending.page === page ? pending : null;
}

/** The pending hint if it points at a record in this collection. */
export function takeJumpFor(collection: string): Jump | null {
  return pending && pending.collection === collection && pending.id ? pending : null;
}
