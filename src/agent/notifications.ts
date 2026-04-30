import { Notification } from 'electron';

export type ToastSeverity = 'info' | 'warning' | 'error';

interface ToastOptions {
  /** Suppress sound. Heartbeats use silent=true; events use silent=false. */
  silent?: boolean;
}

let warnedUnsupported = false;

export function sendToast(
  title: string,
  body: string,
  opts: ToastOptions = {},
): void {
  if (!Notification.isSupported()) {
    if (!warnedUnsupported) {
      console.warn(
        '[modmixer] Notifications not supported on this platform — toasts disabled.',
      );
      warnedUnsupported = true;
    }
    return;
  }
  try {
    const n = new Notification({
      title,
      body,
      silent: opts.silent ?? false,
    });
    n.on('show', () => console.log(`[modmixer] toast shown: ${title} — ${body}`));
    n.on('failed', (_e, err) =>
      console.error(`[modmixer] toast failed: ${title} — ${body}`, err),
    );
    n.show();
  } catch (err) {
    console.error('[modmixer] sendToast threw:', err);
  }
}
