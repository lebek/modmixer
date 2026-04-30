import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { loadSettings } from './settings.js';

/** Configured at build time via Vite's `define`. Empty = disabled. */
declare const __SENTRY_DSN__: string;

const SENTRY_DSN: string =
  typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : '';

/**
 * Initialize Sentry in the main process. Auto-attaches the renderer when
 * @sentry/electron/renderer is also imported there. Strips local user
 * paths from breadcrumbs so we don't ship the user's Steam id or home
 * directory upstream.
 */
export function initSentry(): void {
  if (!SENTRY_DSN) return;

  const { distinctId } = loadSettings();

  Sentry.init({
    dsn: SENTRY_DSN,
    release: `modmixer@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    // No perf tracing for now — crash + error reporting only.
    tracesSampleRate: 0,
    initialScope: {
      user: { id: distinctId },
    },
    sendDefaultPii: false,
    beforeSend(event) {
      // Drop IP if Sentry's relay attached one (sendDefaultPii: false should
      // already prevent this, but belt-and-braces — the user is identified
      // only by the anonymous distinctId).
      if (event.user) delete event.user.ip_address;
      return scrubLocalPaths(event);
    },
    beforeBreadcrumb(crumb) {
      if (typeof crumb.message === 'string') {
        crumb.message = scrubString(crumb.message);
      }
      if (crumb.data) {
        for (const k of Object.keys(crumb.data)) {
          const v = crumb.data[k];
          if (typeof v === 'string') crumb.data[k] = scrubString(v);
        }
      }
      return crumb;
    },
  });
}

/**
 * Walk the event payload and replace anything that looks like a local
 * filesystem path with a placeholder. RimWorld mod paths often contain
 * the user's Steam id and home dir — neither of which we need to debug
 * a crash, and both of which are PII-adjacent.
 */
function scrubLocalPaths<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.message) event.message = scrubString(event.message);
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (v.value) v.value = scrubString(v.value);
      if (v.stacktrace?.frames) {
        for (const f of v.stacktrace.frames) {
          if (f.filename) f.filename = scrubString(f.filename);
          if (f.abs_path) f.abs_path = scrubString(f.abs_path);
          if (f.module) f.module = scrubString(f.module);
        }
      }
    }
  }
  if (event.extra) {
    for (const k of Object.keys(event.extra)) {
      const v = event.extra[k];
      if (typeof v === 'string') event.extra[k] = scrubString(v);
    }
  }
  return event;
}

const HOME_RE = /\/(Users|home)\/[^/]+/g;
const WIN_USER_RE = /[A-Z]:\\Users\\[^\\]+/gi;

function scrubString(s: string): string {
  return s.replace(HOME_RE, '/$1/<user>').replace(WIN_USER_RE, 'C:\\Users\\<user>');
}
