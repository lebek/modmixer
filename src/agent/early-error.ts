// Imported FIRST from src/main.ts so its module body runs before any other
// import's body — including the imports that may throw during bundled require()
// resolution (e.g. an external in vite.main.config.ts that wasn't shipped via
// extraResource in forge.config.ts). The web-tree-sitter v0.4.4 crash was
// exactly this case: the failure happened during top-level import evaluation,
// before initSentry() could run, so nothing caught it and the user got
// Electron's default crash dialog.
//
// In smoke-test mode (--smoke-test in argv) we exit non-zero on any uncaught
// error so CI sees a clear failure signal. In normal mode we leave Electron's
// default dialog behavior alone — changing that would be a separate UX call.

const isSmokeTest = process.argv.includes('--smoke-test');

if (isSmokeTest) {
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[smoke-test] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[smoke-test] unhandledRejection:', reason);
    process.exit(1);
  });
}

export const SMOKE_TEST = isSmokeTest;
