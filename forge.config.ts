import { execFileSync } from 'node:child_process';
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

const ICON_BASE = path.resolve(__dirname, 'assets/icon');

// Azure Trusted Signing wiring. The release workflow installs the
// Microsoft.Trusted.Signing.Client NuGet package on Windows runners and writes
// a metadata file describing the cert profile, then exposes both paths via
// these env vars. When unset (local dev, non-Windows CI) signing is skipped.
const WINDOWS_SIGN_DLIB = process.env.WINDOWS_SIGN_DLIB;
const WINDOWS_SIGN_METADATA = process.env.WINDOWS_SIGN_METADATA;
const windowsSign = WINDOWS_SIGN_DLIB && WINDOWS_SIGN_METADATA
  ? {
      // Trusted Signing certs are short-lived (~3 days), so an RFC 3161
      // timestamp from Microsoft's TSA is required for the signature to stay
      // valid after the cert expires.
      // /fd is injected by @electron/windows-sign from its `hashes` option
      // (defaults to SHA256), so don't include it here or signtool errors with
      // "You cannot use the /fd option twice."
      signWithParams: `/v /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "${WINDOWS_SIGN_DLIB}" /dmdf "${WINDOWS_SIGN_METADATA}"`,
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
    // copy the whole directory into Contents/Resources/ and require it from
    // process.resourcesPath at runtime. node_modules/steamworks.js/dist/
    // already contains the per-platform binaries for win-x64, mac-x64,
    // mac-arm64, and linux-x64, so a single copy works on every target.
    extraResource: [
      'node_modules/steamworks.js',
      'dist/LICENSES.txt',
      'lore',
      // Index engine assets. ilspycmd binaries are ~30-50 MB per platform;
      // only the matching <platform>-<arch> subdir for the build host needs
      // a binary present (see resources/ilspycmd/README.md). The tree-sitter
      // C# grammar wasm (~1 MB) is fetched at install time by
      // scripts/fetch-tree-sitter-csharp.mjs.
      'resources/ilspycmd',
      'resources/tree-sitter',
      // Bundled ripgrep — used by search_source against the decompiled
      // RimWorld source corpus. @vscode/ripgrep installs platform binaries
      // under node_modules/@vscode/ripgrep/bin/, which we ship as-is.
      'node_modules/@vscode/ripgrep',
      // better-sqlite3 native binding for the index DB. Like steamworks.js,
      // the .node file can't be bundled by Rollup, so we ship the whole
      // module and resolve it from resourcesPath at runtime.
      'node_modules/better-sqlite3',
    ],
  },
  hooks: {
    generateAssets: async () => {
      execFileSync(
        process.execPath,
        [path.resolve(__dirname, 'scripts/generate-licenses.mjs')],
        { stdio: 'inherit' },
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ setupIcon: `${ICON_BASE}.ico`, windowsSign }),
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
        name: 'modmixer-releases',
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
