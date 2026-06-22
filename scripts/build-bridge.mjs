#!/usr/bin/env node
// Build the ModMixer NeoForge diagnostics bridge mod and stage the jar at
// resources/modmixer-bridge.jar (what minecraft/launch.ts loads into runClient).
//
// Prereqs: the MDK template must be vendored (npm run fetch:neoforge-mdk) so we
// can borrow its Gradle wrapper, and a JDK 21 must be resolvable (JAVA_HOME, or
// `/usr/libexec/java_home -v 21` on macOS). The first build downloads NeoForge
// and decompiles Minecraft, so it can take a while.
//
// Run: npm run build:bridge
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'vendor', 'modmixer-bridge-neoforge');
const template = path.join(root, 'vendor', 'neoforge-mdk', 'template');
const isWin = process.platform === 'win32';

function fail(msg) {
  console.error(`[build:bridge] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(bridge, 'build.gradle'))) {
  fail(`bridge project missing at ${bridge}`);
}

// Borrow the Gradle wrapper from the vendored MDK (the bridge project ships
// without the binary wrapper jar).
if (!fs.existsSync(path.join(bridge, isWin ? 'gradlew.bat' : 'gradlew'))) {
  if (!fs.existsSync(path.join(template, 'gradlew'))) {
    fail('MDK template not vendored — run `npm run fetch:neoforge-mdk` first.');
  }
  for (const f of ['gradlew', 'gradlew.bat']) {
    fs.copyFileSync(path.join(template, f), path.join(bridge, f));
  }
  fs.cpSync(path.join(template, 'gradle'), path.join(bridge, 'gradle'), { recursive: true });
  if (!isWin) fs.chmodSync(path.join(bridge, 'gradlew'), 0o755);
}

function resolveJavaHome() {
  const fromEnv = process.env.JAVA_HOME;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'bin', isWin ? 'javac.exe' : 'javac'))) {
    return fromEnv;
  }
  if (process.platform === 'darwin') {
    try {
      const home = execFileSync('/usr/libexec/java_home', ['-v', '21', '-F'], {
        encoding: 'utf8',
      }).trim();
      if (home) return home;
    } catch {
      /* none */
    }
  }
  fail('No JDK 21 found. Set JAVA_HOME to a JDK 21 and retry.');
}

const javaHome = resolveJavaHome();
console.log(`[build:bridge] JAVA_HOME=${javaHome}`);

const wrapper = path.join(bridge, isWin ? 'gradlew.bat' : 'gradlew');
const res = spawnSync(wrapper, ['build', '--no-daemon', '--console=plain'], {
  cwd: bridge,
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, JAVA_HOME: javaHome },
});
if (res.status !== 0) fail(`gradle build failed (exit ${res.status})`);

const libs = path.join(bridge, 'build', 'libs');
const jar = fs
  .readdirSync(libs)
  .find((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
if (!jar) fail('no jar produced in build/libs');

fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
const dest = path.join(root, 'resources', 'modmixer-bridge.jar');
fs.copyFileSync(path.join(libs, jar), dest);
console.log(`[build:bridge] staged ${jar} -> ${dest}`);
