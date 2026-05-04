#!/usr/bin/env node
// Cut a tester build via GitHub Actions workflow_dispatch and download the
// signed installer for handing to a remote tester (e.g. via Discord).
//
// Usage:
//   node scripts/tester-build.mjs [--target <win-x64|win-arm64|all>]
//
// Default target: win-x64 (covers most testers). `all` builds every matrix
// entry; `win-arm64` only the ARM64 Windows entry.
//
// Notes:
// - Working tree must be clean (uncommitted changes won't be in the build).
// - Auto-pushes the current branch if it has unpushed commits.
// - Dispatches release.yml on the current branch — release.yml's
//   workflow_dispatch path runs `electron-forge make` and uploads the
//   signed installer as a workflow artifact (no tagging, no GitHub Release).
// - Requires `gh` on PATH and `gh auth login` completed.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const REPO = 'lebek/modmixer';
const RELEASE_WORKFLOW = 'release.yml';

// Map our short target keys to the artifact names release.yml uploads.
// The artifact name is `modmixer-${matrix.os}-${matrix.arch}` per the
// upload-artifact step in release.yml.
const ARTIFACT_NAMES = {
  'win-x64': 'modmixer-windows-latest-x64',
  'win-arm64': 'modmixer-windows-11-arm-arm64',
};
const VALID_TARGETS = ['win-x64', 'win-arm64', 'all'];

const isWin = process.platform === 'win32';

function ensureGhOnPath() {
  if (tryCapture('gh', ['--version']).ok) return;
  if (!isWin) return;
  const candidates = [
    'C:\\Program Files\\GitHub CLI',
    'C:\\Program Files (x86)\\GitHub CLI',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'gh.exe'))) {
      process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
      return;
    }
  }
}

function exec(cmd, args, opts = {}) {
  const isShim = isWin && (cmd === 'npm' || cmd === 'npx');
  const actualCmd = isShim ? `${cmd}.cmd` : cmd;
  const shellOpt = isShim ? { shell: true } : {};
  return spawnSync(actualCmd, args, { cwd: repoRoot, ...shellOpt, ...opts });
}

function run(cmd, args, opts = {}) {
  const result = exec(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function capture(cmd, args, opts = {}) {
  const result = exec(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited with status ${result.status}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

function tryCapture(cmd, args, opts = {}) {
  const result = exec(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function walkSync(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSync(p));
    else out.push(p);
  }
  return out;
}

async function main() {
  const target = getArg('target') ?? 'win-x64';
  if (!VALID_TARGETS.includes(target)) {
    console.error(`error: --target must be one of: ${VALID_TARGETS.join(', ')}`);
    process.exit(2);
  }

  // ---- preflight ----
  section('preflight');

  ensureGhOnPath();
  const ghAuth = tryCapture('gh', ['auth', 'status']);
  if (!ghAuth.ok) {
    console.error('error: `gh` not available or not authenticated. Run `gh auth login`.');
    console.error(ghAuth.stderr || ghAuth.stdout);
    process.exit(1);
  }

  const dirty = capture('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.error('error: working tree is dirty. Commit or stash first.');
    console.error(dirty);
    process.exit(1);
  }

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch === 'HEAD') {
    console.error('error: detached HEAD. Check out a branch first.');
    process.exit(1);
  }

  // Push the branch if it has unpushed commits, or if it doesn't exist on
  // origin yet. workflow_dispatch reads release.yml from the dispatched ref,
  // so the branch (with whatever forge.config.ts / src/ changes you want
  // tested) must be on origin.
  run('git', ['fetch', 'origin', branch, '--quiet'], { stdio: 'inherit' });
  const localSha = capture('git', ['rev-parse', 'HEAD']).trim();
  const remoteRef = tryCapture('git', ['rev-parse', `origin/${branch}`]);
  if (!remoteRef.ok || remoteRef.stdout.trim() !== localSha) {
    section(`pushing ${branch} to origin`);
    run('git', ['push', 'origin', branch]);
  }

  // ---- dispatch ----
  section(`dispatching ${RELEASE_WORKFLOW} on ${branch} (target: ${target})`);
  run('gh', ['workflow', 'run', RELEASE_WORKFLOW, '--ref', branch]);

  // ---- find the new run ----
  // gh dispatches asynchronously; the run shows up in `gh run list` a few
  // seconds later. We match on event=workflow_dispatch + headBranch=<branch>
  // + headSha=<localSha>, taking the most recent.
  section('finding workflow run');
  let runId = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const list = tryCapture('gh', [
      'run',
      'list',
      `--workflow=${RELEASE_WORKFLOW}`,
      '--event=workflow_dispatch',
      '--branch',
      branch,
      '--limit=5',
      '--json',
      'databaseId,headSha,createdAt',
    ]);
    if (!list.ok) continue;
    let runs;
    try { runs = JSON.parse(list.stdout); } catch { continue; }
    const ours = runs.find(r => r.headSha === localSha);
    if (ours) { runId = ours.databaseId; break; }
    process.stdout.write('.');
  }
  if (!runId) {
    console.error(
      `\nerror: could not find workflow run after ~60s. Check https://github.com/${REPO}/actions`,
    );
    process.exit(1);
  }
  const runUrl = `https://github.com/${REPO}/actions/runs/${runId}`;
  console.log(`\nrun id: ${runId} — ${runUrl}`);

  // ---- watch ----
  // ARM64 Windows runners + dotnet build can take a while; budget ~15 min.
  section('watching build (this takes ~10-15 min)');
  const watch = exec(
    'gh',
    ['run', 'watch', String(runId), '--exit-status'],
    { stdio: 'inherit' },
  );
  if (watch.status !== 0) {
    console.error(`\nerror: build failed. See ${runUrl}`);
    process.exit(1);
  }

  // ---- download ----
  const wantedTargets = target === 'all' ? Object.keys(ARTIFACT_NAMES) : [target];
  const downloadDir = path.join(repoRoot, 'out', 'tester-build', String(runId));
  fs.mkdirSync(downloadDir, { recursive: true });

  for (const t of wantedTargets) {
    const name = ARTIFACT_NAMES[t];
    section(`downloading ${name}`);
    run('gh', [
      'run', 'download', String(runId),
      '--name', name,
      '--dir', path.join(downloadDir, t),
    ]);
  }

  // ---- locate Setup.exe ----
  const setups = walkSync(downloadDir).filter(p => /Setup\.exe$/i.test(p));
  if (setups.length === 0) {
    console.error(`\nwarning: no Setup.exe found under ${downloadDir}`);
    console.error('All downloaded files:');
    for (const f of walkSync(downloadDir)) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log('\n=== ready to share ===');
  for (const exe of setups) {
    const stat = fs.statSync(exe);
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`  ${exe}  (${mb} MB)`);
  }
  console.log(`\nRun: ${runUrl}`);
  console.log(
    '\nDiscord caps uploads at 25 MB (50 MB Nitro) — for the ~150-200 MB',
  );
  console.log(
    'installer use a file host (Drive, WeTransfer) or share the GitHub',
  );
  console.log('artifact URL with a tester who has repo read access.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
