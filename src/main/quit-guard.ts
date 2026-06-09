// Shared flag bridging the window `close` handler (main.ts) and the paths that
// legitimately want to quit without re-asking the user: the renderer's quit
// confirmation reply, and the updater's "restart & install". Without it, the
// close handler would loop those approved quits back to the renderer for
// another confirmation (or, for the updater, fight its app.quit() sequence).
let approved = false;

/** Mark the next window close as already approved — it should not be intercepted. */
export function approveQuit(): void {
  approved = true;
}

/** True once a quit has been approved (renderer confirm or update install). */
export function isQuitApproved(): boolean {
  return approved;
}
