import { execFileSync } from 'node:child_process';
import fsSync, { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { rebuild } from '@electron/rebuild';

const requireCJS = createRequire(__filename);

const ICON_BASE = path.resolve(__dirname, 'assets/icon');

// Probe the installed Electron binary's PE machine type so cross-arch dev
// environments (Windows-on-ARM running an x64 Electron under Prism) rebuild
// native modules against the *Electron* arch, not the host arch. Without
// this, `@electron/rebuild` defaults to process.arch (arm64) and produces a
// .node the x64 Electron refuses to load with "not a valid Win32
// application". On non-Windows or when the probe fails, falls back to
// process.arch — which is correct on real native installs and in CI (where
// host arch always equals Electron arch).
function detectElectronArch(): NodeJS.Architecture {
  if (process.platform !== 'win32') return process.arch;
  const electronExe = path.resolve(
    __dirname,
    'node_modules/electron/dist/electron.exe',
  );
  try {
    const fd = fsSync.openSync(electronExe, 'r');
    try {
      const buf = Buffer.alloc(1024);
      fsSync.readSync(fd, buf, 0, 1024, 0);
      const peOff = buf.readInt32LE(0x3c);
      const machine = buf.readUInt16LE(peOff + 4);
      if (machine === 0x8664) return 'x64';
      if (machine === 0xaa64) return 'arm64';
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    // Electron not installed yet, or the path differs from expectations —
    // fall through to the host-arch fallback.
  }
  return process.arch;
}

// Resolve the target arch for staging. Forge's CLI passes --arch=<arch> to
// the make/package command; we parse it out of process.argv here so that
// cross-arch local makes (e.g. `npm run make -- --arch=x64` from an ARM64
// host) produce dist/<mod>/ with the right-arch binary. Falls back to
// detectElectronArch() — i.e. whichever arch the installed Electron itself
// is — so dev (`npm start`, no --arch flag) doesn't produce a .node that
// Electron can't load.
function getTargetArch(): NodeJS.Architecture {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--arch' && process.argv[i + 1]) {
      return process.argv[i + 1] as NodeJS.Architecture;
    }
    if (arg.startsWith('--arch=')) {
      return arg.slice('--arch='.length) as NodeJS.Architecture;
    }
  }
  return detectElectronArch();
}

// Stage better-sqlite3 with its `bindings` and `file-uri-to-path` runtime
// deps nested under its own node_modules/. npm hoists them to the top-level
// node_modules in dev, but we ship better-sqlite3 as a stand-alone
// extraResource — without nesting them, lib/database.js's `require('bindings')`
// fails in packaged builds with "Cannot find module 'bindings'".
//
// Reads from `<project>/node_modules/`. We can't use <buildPath> because
// electron-packager's copy filter (galactus) prunes any native module out
// of <buildPath>/node_modules/ before our hooks fire — broke v0.6.3 and
// v0.6.4 when packageAfterPrune was tried. Instead, we explicitly rebuild
// the project copy here against Electron's ABI for the target arch, then
// copy. Forge's own @electron/rebuild step also fires later (against
// buildPath) but its output isn't reachable from our extraResource path.
async function stageBetterSqlite() {
  const electronVersion = (
    requireCJS('electron/package.json') as { version: string }
  ).version;
  const arch = getTargetArch();
  await rebuild({
    buildPath: __dirname,
    electronVersion,
    arch,
    onlyModules: ['better-sqlite3'],
    force: true,
  });

  const src = path.resolve(__dirname, 'node_modules/better-sqlite3');
  const dest = path.resolve(__dirname, 'dist/better-sqlite3');
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  for (const dep of ['bindings', 'file-uri-to-path']) {
    await fs.cp(
      path.resolve(__dirname, `node_modules/${dep}`),
      path.join(dest, 'node_modules', dep),
      { recursive: true },
    );
  }
}

// Stage the in-game Modmixer Bridge as a clean RimWorld mod folder. The
// vendor/ source tree also contains the C# project (.csproj + Source/) and
// a LICENSE — RimWorld doesn't care about those, and shipping the .cs files
// would just bloat every installer. Copy only About/ and Assemblies/ to
// dist/modmixer-bridge/, which gets extraResource'd into the packaged app.
// bridge-install.ts dual-resolves between this and the dev vendor/ path at
// runtime.
async function stageBridge() {
  const src = path.resolve(__dirname, 'vendor/modmixer-bridge');
  const dest = path.resolve(__dirname, 'dist/modmixer-bridge');
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const sub of ['About', 'Assemblies']) {
    await fs.cp(path.join(src, sub), path.join(dest, sub), { recursive: true });
  }
}

// Stage steamworks.js with only the host platform's native binding subdir.
// node_modules/steamworks.js/dist/ ships {win64, osx, linux64}; signtool
// can only sign Windows PE binaries, so leaving Linux/macOS .node files in
// the Windows installer makes signing fail with "This file format cannot
// be signed because it is not recognized." The runtime require() in
// node_modules/steamworks.js/index.js only loads the matching subdir for
// the current process.platform anyway, so the dropped subdirs are dead
// weight on every platform.
async function stagePrunedSteamworks() {
  const src = path.resolve(__dirname, 'node_modules/steamworks.js');
  const dest = path.resolve(__dirname, 'dist/steamworks.js');
  const keep = process.platform === 'win32' ? 'win64'
    : process.platform === 'darwin' ? 'osx'
    : 'linux64';
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  for (const subdir of ['win64', 'osx', 'linux64']) {
    if (subdir !== keep) {
      await fs.rm(path.join(dest, 'dist', subdir), { recursive: true, force: true });
    }
  }
}

// Stage the pi agent packages (and their full runtime dependency closure)
// inside a directory literally named node_modules so they land at
// resources/node_modules/ in the packaged app. As of pi 0.80.x the packages
// can't be bundled (bundler-proof dynamic imports in the OAuth flows, jiti
// extension loading, import.meta.url asset resolution), so vite.main.config.ts
// marks them external and the bundled main.js resolves them at runtime by
// bare-specifier directory walk-up out of the asar — app.asar/.vite/build →
// app.asar → resources/node_modules.
//
// The closure is computed from the installed tree, not hand-listed: every
// dependency that resolves at the project's top-level node_modules is copied
// there; packages that resolve nested (pi-coding-agent ships an
// npm-shrinkwrap.json, so npm installs its entire tree under its own
// node_modules/) travel with their parent's recursive copy. This includes
// @silvia-odwyer/photon-node, the WASM image library behind pi's read tool,
// which was previously the sole staged package here.
async function stagePiNodeModules() {
  const projectNm = path.resolve(__dirname, 'node_modules');
  const stageRoot = path.resolve(__dirname, 'dist/node_modules');
  await fs.rm(stageRoot, { recursive: true, force: true });

  const roots = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    'typebox',
    // Usually absent at the top level: pi-coding-agent's shrinkwrap keeps it
    // nested under its own node_modules/, where pi's read tool resolves it.
    // Listed so it still ships standalone if a future install hoists it.
    '@silvia-odwyer/photon-node',
  ].filter((name) =>
    fsSync.existsSync(path.join(projectNm, name, 'package.json')),
  );
  const staged = new Set<string>(roots);
  const visited = new Set<string>();

  const walk = async (pkgDir: string): Promise<void> => {
    if (visited.has(pkgDir)) return;
    visited.add(pkgDir);
    let pkg: {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(
        await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'),
      );
    } catch {
      return;
    }
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    });
    for (const dep of deps) {
      // Node resolution: nearest node_modules walking up from the dependent,
      // stopping at the project root. Missing deps are skipped — platform-
      // specific optionalDependencies legitimately aren't installed.
      let found: string | null = null;
      for (
        let dir = pkgDir;
        ;
        dir = path.dirname(dir)
      ) {
        const candidate = path.join(dir, 'node_modules', dep);
        if (fsSync.existsSync(path.join(candidate, 'package.json'))) {
          found = candidate;
          break;
        }
        if (dir === __dirname || path.dirname(dir) === dir) break;
      }
      if (!found) continue;
      // Top-level resolutions must be staged by name; nested ones ship
      // inside their parent's copy but still get walked, because their own
      // deps may resolve at the top level.
      if (path.relative(projectNm, found).split(path.sep).join('/') === dep) {
        staged.add(dep);
      }
      await walk(found);
    }
  };

  for (const name of roots) {
    await walk(path.join(projectNm, name));
  }
  for (const name of staged) {
    await fs.cp(path.join(projectNm, name), path.join(stageRoot, name), {
      recursive: true,
    });
  }
  await pruneForeignNativeAddons(stageRoot);
}

// Drop native addons built for a different OS from the staged pi tree. The
// closure bundles prebuilt .node binaries for every platform: pi-tui ships
// native/{darwin,win32}/prebuilds/…, and napi packages ship one .node per OS.
// On Windows signtool refuses to sign a non-PE binary ("This file format
// cannot be signed because it is not recognized") and fails the entire package
// step; on every platform the foreign ones are dead weight the runtime never
// loads (require() only pulls the matching-OS binary). Classify by magic bytes
// rather than directory names so this stays correct however upstream lays out
// its prebuilds — it was a new pi-tui prebuild layout that first broke this.
async function pruneForeignNativeAddons(root: string): Promise<void> {
  const target =
    process.platform === 'win32' ? 'pe'
    : process.platform === 'darwin' ? 'macho'
    : 'elf';
  const classify = (b: Buffer): 'pe' | 'macho' | 'elf' | 'unknown' => {
    if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'pe'; // "MZ"
    if (
      b.length >= 4 &&
      b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 // \x7fELF
    ) return 'elf';
    if (b.length >= 4) {
      // Mach-O thin (32/64, either endianness) or universal ("fat") binaries.
      const magic = b.readUInt32BE(0);
      if (
        magic === 0xfeedface || magic === 0xcefaedfe || // 32-bit
        magic === 0xfeedfacf || magic === 0xcffaedfe || // 64-bit
        magic === 0xcafebabe || magic === 0xbebafeca    // fat
      ) return 'macho';
    }
    return 'unknown';
  };
  const entries = await fs.readdir(root, { recursive: true });
  for (const rel of entries) {
    if (!rel.endsWith('.node')) continue;
    const file = path.join(root, rel);
    const head = Buffer.alloc(4);
    const fh = await fs.open(file, 'r');
    try {
      await fh.read(head, 0, 4, 0);
    } finally {
      await fh.close();
    }
    const kind = classify(head);
    // Keep target-OS binaries and anything unrecognized (never guess a real
    // addon into deletion); only drop binaries positively identified as foreign.
    if (kind !== 'unknown' && kind !== target) {
      await fs.rm(file, { force: true });
    }
  }
}

// Azure Trusted Signing wiring. The release workflow installs the
// Microsoft.Trusted.Signing.Client NuGet package on Windows runners and writes
// a metadata file describing the cert profile, then exposes both paths via
// these env vars. When unset (local dev, non-Windows CI) signing is skipped.
const WINDOWS_SIGN_DLIB = process.env.WINDOWS_SIGN_DLIB;
const WINDOWS_SIGN_METADATA = process.env.WINDOWS_SIGN_METADATA;
const windowsSign = WINDOWS_SIGN_DLIB && WINDOWS_SIGN_METADATA
  ? {
      // SHA256-only. windows-sign defaults to dual-signing SHA1+SHA256, but
      // Trusted Signing is SHA256-only and the SHA1 pass uses the legacy /t
      // timestamp flag which collides with /tr from the TSA below.
      hashes: ['sha256'] as never,
      // Trusted Signing requires Microsoft's RFC 3161 timestamp server.
      // windows-sign emits this as `/tr <url> /td <hash>` automatically — do
      // NOT also pass /tr, /td, or /fd in signWithParams (signtool rejects
      // any of those options twice).
      timestampServer: 'http://timestamp.acs.microsoft.com',
      // No quotes around the paths: @electron/windows-sign splits this string
      // by whitespace (preserving any quote chars literally) and passes the
      // resulting tokens to signtool via spawn — no shell to strip quotes,
      // so quoted paths get the quotes embedded in the arg and signtool
      // can't find the file. The CI runner paths (D:\a\_temp\...) don't
      // contain spaces, so unquoted is safe.
      signWithParams: `/v /dlib ${WINDOWS_SIGN_DLIB} /dmdf ${WINDOWS_SIGN_METADATA}`,
    }
  : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: ICON_BASE,
    windowsSign,
    // Lowercase to match package.json#name. maker-deb derives the binary
    // name it looks for from package.json#name, so without this it can't
    // find a binary called "Modmixer" (driven by productName).
    executableName: 'modmixer',
    // The Forge Vite plugin bundles main/preload via Rollup and does not ship
    // node_modules. steamworks.js is a native module (Steam SDK redistributable
    // + .node binding sibling files) that can't be bundled by Rollup, so we
    // copy a per-host-platform-pruned staging dir into Contents/Resources/
    // and require it from process.resourcesPath at runtime. The staging dir
    // is built in generateAssets — we drop foreign-platform .node files
    // because (a) signtool can't sign Linux ELF / macOS Mach-O so the
    // Windows installer fails to package them, and (b) shipping unused
    // binaries just bloats every installer.
    extraResource: [
      'dist/steamworks.js',
      'dist/LICENSES.txt',
      'lore',
      // Curated cookbook — read-only reference for external frameworks (CE,
      // Harmony). Shipped as-is from the repo root; the agent reads sections
      // with the ordinary read tool (cookbookDir is in PathPolicyRoots).
      'cookbook',
      // In-game bridge mod (Harmony-patched diagnostics over localhost TCP).
      // Staged in generateAssets so we ship only About/ + Assemblies/, not
      // the C# source. bridge-install.ts junctions this into RimWorld's
      // Mods/ during run_test_cycle when the user doesn't already have the
      // bridge installed via Workshop.
      'dist/modmixer-bridge',
      // The Modmixer Live mod is NOT bundled: packaged builds get it from
      // the Steam Workshop (see live/install.ts), dev uses vendor/ directly.
      // Index engine assets. ilspycmd binaries are ~30-50 MB per platform;
      // only the matching <platform>-<arch> subdir for the build host needs
      // a binary present (see resources/ilspycmd/README.md). The tree-sitter
      // C# grammar wasm (~1 MB) is fetched at install time by
      // scripts/fetch-tree-sitter-csharp.mjs; the Java grammar (Minecraft
      // source index) by scripts/fetch-tree-sitter-java.mjs at build time.
      'resources/ilspycmd',
      'resources/tree-sitter',
      // Vineflower decompiler jar — inspect_mod runs it (via the provisioned
      // JDK 21) to decompile an installed NeoForge mod's classes. Platform-
      // independent runnable jar; fetched by scripts/fetch-vineflower.mjs.
      'resources/vineflower',
      // --- Minecraft (NeoForge) toolchain assets ---
      // MC mods are scaffolded by copying this MDK template (fetched, not
      // committed — scripts/fetch-neoforge-mdk.mjs). scaffold.ts resolves it at
      // resourcesPath/neoforge-mdk/template in packaged builds.
      'vendor/neoforge-mdk',
      // The NeoForge diagnostics bridge jar, passed to `gradlew runClient` via
      // -PmodmixerBridgeJar. launch.ts resolves it at
      // resourcesPath/modmixer-bridge.jar in packaged builds.
      'resources/modmixer-bridge.jar',
      // Bundled ripgrep — used by search_source against the decompiled
      // RimWorld source corpus. @vscode/ripgrep installs platform binaries
      // under node_modules/@vscode/ripgrep/bin/, which we ship as-is.
      'node_modules/@vscode/ripgrep',
      // better-sqlite3 native binding for the index DB. Like steamworks.js,
      // the .node file can't be bundled by Rollup, so we ship the whole
      // module and resolve it from resourcesPath at runtime. Staged in
      // generateAssets, where stageBetterSqlite explicitly rebuilds against
      // Electron's ABI for the target arch and nests `bindings` /
      // `file-uri-to-path` under node_modules/ so require() resolves.
      'dist/better-sqlite3',
      // web-tree-sitter is marked external in vite.main.config.ts (it ships
      // a .wasm sibling that Rollup can't inline), so the bundled main.js
      // does require('web-tree-sitter') at runtime — needs the module on
      // disk. csharp-indexer.ts loads it via the dual-resolve pattern.
      'node_modules/web-tree-sitter',
      // @resvg/resvg-wasm is the SVG-to-PNG renderer behind render_svg_to_png.
      // Same wasm-sibling story as web-tree-sitter: marked external in vite,
      // shipped via extraResource, and resolved at runtime via the
      // dual-resolve pattern in render-svg-to-png.ts.
      'node_modules/@resvg/resvg-wasm',
      // TTFs loaded by the @font-face declarations in
      // assets/preview-templates/_shared.css (relative `../fonts/*.ttf`).
      // Flattens to resources/fonts/ (electron-packager basename rule),
      // resolved at runtime via the same dual-resolve pattern as the wasm
      // modules.
      'assets/fonts',
      // HTML/CSS/JS templates for render_preview. Flattens to
      // resources/preview-templates/, resolved at runtime in
      // preview-template-renderer.ts via the dual-resolve pattern.
      'assets/preview-templates',
      // Staged node_modules tree: the pi agent packages plus their full
      // runtime dependency closure (and photon-node). Flattens to
      // resources/node_modules/, so the bundled main.js's external
      // require('@earendil-works/…') and pi's own internal imports resolve
      // by directory walk-up out of the asar. Built by stagePiNodeModules in
      // generateAssets; see that function for why pi can't be bundled or use
      // the resourcesPath dual-resolve pattern the other native/wasm deps use.
      'dist/node_modules',
    ],
  },
  hooks: {
    generateAssets: async () => {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, 'scripts/generate-licenses.mjs')],
        { stdio: 'inherit' },
      );
      await stagePrunedSteamworks();
      await stageBetterSqlite();
      await stageBridge();
      await stagePiNodeModules();
    },
  },
  // Forge's ForgeRebuildOptions explicitly omits `arch`; the value is read
  // from `process.env.npm_config_arch || process.arch` inside its start()
  // entrypoint. scripts/dev-start.mjs probes Electron's actual PE arch and
  // sets that env var before invoking electron-forge, so on Windows-on-ARM
  // (host arm64, Electron x64 via Prism) the rebuild lands on x64.
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      setupIcon: `${ICON_BASE}.ico`,
      loadingGif: path.resolve(__dirname, 'assets/loading.gif'),
      windowsSign,
    }),
    // ZIP is required on darwin: Squirrel.Mac applies updates from a .zip.
    // Mac is currently unsigned so updates won't actually apply, but ship
    // the artifact anyway so we can flip to signed without changing makers.
    new MakerZIP({}, ['darwin']),
    new MakerDMG({ icon: `${ICON_BASE}.icns` }, ['darwin']),
    new MakerDeb({ options: { icon: `${ICON_BASE}.png` } }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'lebek',
        name: 'modmixer',
      },
      prerelease: false,
      draft: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // Short-lived helper process that owns the Steamworks connection
          // during a Workshop publish (see src/agent/workshop-publish-host.ts
          // for why it can't live in the main process). Bundled as its own
          // `main` target so it lands in .vite/build/ next to main.js, which
          // is where PublishHost forks it from.
          entry: 'src/agent/workshop-publish-host.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
