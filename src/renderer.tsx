import * as Sentry from '@sentry/electron/renderer';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { ConsentGate } from './components/consent-gate';

declare const __SENTRY_DSN__: string;

// Main-process Sentry init carries the config (DSN, release, environment).
// The renderer just needs an empty init() so /renderer hooks into the same
// transport — but only when a DSN is configured at build time. Calling
// init() with an empty DSN would still install hooks and forward to a
// missing main-process client.
if (typeof __SENTRY_DSN__ === 'string' && __SENTRY_DSN__) {
  Sentry.init({});
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(<ConsentGate />);
