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

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: ICON_BASE,
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
    extraResource: ['node_modules/steamworks.js', 'dist/LICENSES.txt'],
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
    new MakerSquirrel({ setupIcon: `${ICON_BASE}.ico` }),
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
