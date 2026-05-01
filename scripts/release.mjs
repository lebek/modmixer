#!/usr/bin/env node
// Cut a release: bump version, commit, tag, push, watch the GitHub Actions
// build, then overwrite the auto-generated release notes on
// lebek/modmixer-releases with the curated notes.
//
// Usage:
//   node scripts/release.mjs --notes-file <path> [--major | --minor | --patch | --version X.Y.Z]
//
// Notes:
// - Tag is pushed to the dev repo (lebek/modmixer); CI publishes the release
//   to lebek/modmixer-releases via electron-forge's PublisherGithub. We then
//   edit that release's body to replace whatever the publisher wrote.
// - Requires `gh` on PATH and `gh auth login` completed.
// - Run from a clean working tree on `main` that's in sync with origin.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEV_REPO = 'lebek/modmixer';
const RELEASES_REPO = 'lebek/modmixer-releases';
const RELEASE_WORKFLOW = 'release.yml';

const isWin = process.platform === 'win32';

function exec(cmd, args, opts = {}) {
  // npm/npx are .cmd shims on Windows; spawnSync needs the explicit extension.
  const actualCmd = isWin && (cmd === 'npm' || cmd === 'npx') ? `${cmd}.cmd` : cmd;
  return spawnSync(actualCmd, args, { cwd: repoRoot, ...opts });
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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function bump(version, kind) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const [, maj, min, pat] = m.map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const notesFile = getArg('notes-file');
  if (!notesFile) {
    console.error('error: --notes-file <path> is required');
    process.exit(2);
  }
  if (!fs.existsSync(notesFile)) {
    console.error(`error: notes file not found: ${notesFile}`);
    process.exit(2);
  }
  const notes = fs.readFileSync(notesFile, 'utf8').trim();
  if (!notes) {
    console.error(`error: notes file is empty: ${notesFile}`);
    process.exit(2);
  }

  const explicitVersion = getArg('version');
  const bumpKind = hasFlag('major')
    ? 'major'
    : hasFlag('minor')
      ? 'minor'
      : 'patch';

  // ---- preflight ----
  section('preflight');

  const ghAuth = tryCapture('gh', ['auth', 'status']);
  if (!ghAuth.ok) {
    console.error('error: `gh` not available or not authenticated. Run `gh auth login`.');
    console.error(ghAuth.stderr || ghAuth.stdout);
    process.exit(1);
  }

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== 'main') {
    console.error(`error: expected branch main, got ${branch}`);
    process.exit(1);
  }

  const dirty = capture('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.error('error: working tree is dirty. Commit or stash first.');
    console.error(dirty);
    process.exit(1);
  }

  run('git', ['fetch', 'origin', 'main']);
  const local = capture('git', ['rev-parse', 'HEAD']).trim();
  const remote = capture('git', ['rev-parse', 'origin/main']).trim();
  if (local !== remote) {
    console.error('error: local main is not in sync with origin/main. Pull or push first.');
    process.exit(1);
  }

  section('typecheck');
  run('npm', ['run', 'typecheck']);
  section('test');
  run('npm', ['run', 'test']);

  // ---- version bump ----
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const newVersion = explicitVersion ?? bump(pkg.version, bumpKind);
  const tag = `v${newVersion}`;

  if (capture('git', ['tag', '-l', tag]).trim()) {
    console.error(`error: tag ${tag} already exists locally`);
    process.exit(1);
  }
  const remoteTag = tryCapture('git', ['ls-remote', '--tags', 'origin', tag]);
  if (remoteTag.ok && remoteTag.stdout.trim()) {
    console.error(`error: tag ${tag} already exists on origin`);
    process.exit(1);
  }

  section(`bumping ${pkg.version} -> ${newVersion}`);
  run('npm', ['version', newVersion, '--no-git-tag-version', '--allow-same-version']);

  run('git', ['add', 'package.json', 'package-lock.json']);
  run('git', ['commit', '-m', `Release ${tag}`]);
  run('git', ['tag', tag]);

  section('pushing main + tag');
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  // ---- find + watch the workflow run ----
  section('finding workflow run');
  let runId = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const list = tryCapture('gh', [
      'run',
      'list',
      `--workflow=${RELEASE_WORKFLOW}`,
      '--event=push',
      '--limit=10',
      '--json',
      'databaseId,headBranch,event,createdAt',
    ]);
    if (!list.ok) continue;
    let runs;
    try { runs = JSON.parse(list.stdout); } catch { continue; }
    // For tag pushes, headBranch is the tag name.
    const ours = runs.find(r => r.headBranch === tag);
    if (ours) { runId = ours.databaseId; break; }
    process.stdout.write('.');
  }
  if (!runId) {
    console.error(
      `\nerror: could not find workflow run for ${tag} after ~60s. Check https://github.com/${DEV_REPO}/actions`,
    );
    process.exit(1);
  }
  console.log(`\nrun id: ${runId} — https://github.com/${DEV_REPO}/actions/runs/${runId}`);

  section(`watching build (this takes ~10-15 min)`);
  const watch = exec(
    'gh',
    ['run', 'watch', String(runId), '--exit-status'],
    { stdio: 'inherit' },
  );
  if (watch.status !== 0) {
    console.error(
      `\nerror: build failed. See https://github.com/${DEV_REPO}/actions/runs/${runId}`,
    );
    console.error(
      `tag ${tag} is still in place. Once you fix the issue, you can re-run the workflow from the Actions UI.`,
    );
    process.exit(1);
  }

  // ---- overwrite the release notes ----
  section('publishing release notes');

  // Wait briefly for publisher to finish creating the release.
  let releaseExists = false;
  for (let i = 0; i < 15; i++) {
    const view = tryCapture('gh', [
      'release',
      'view',
      tag,
      '--repo',
      RELEASES_REPO,
    ]);
    if (view.ok) { releaseExists = true; break; }
    await sleep(2000);
  }
  if (!releaseExists) {
    console.error(
      `error: release ${tag} not found in ${RELEASES_REPO} after ~30s. Edit the notes manually.`,
    );
    process.exit(1);
  }

  run('gh', [
    'release',
    'edit',
    tag,
    '--repo',
    RELEASES_REPO,
    '--notes-file',
    notesFile,
  ]);

  const url = capture('gh', [
    'release',
    'view',
    tag,
    '--repo',
    RELEASES_REPO,
    '--json',
    'url',
    '-q',
    '.url',
  ]).trim();

  console.log(`\nreleased ${tag}`);
  console.log(url);
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
