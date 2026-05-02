---
description: Cut a new release — summarize commits, confirm with user, build and publish.
allowed-tools: Bash, Read, Write, Edit
---

# /release

You are running the `/release` command. Walk through these steps in order. Be concise — one sentence per step at most. Do not narrate plans; just do the work.

## 1. Find what's new since the last release

Run:
- `git describe --tags --abbrev=0 2>/dev/null` to get the most recent tag (may be empty if no tags yet).
- `git log <range> --pretty=format:'%h %s%n%b%n---%n'` where `<range>` is `<last-tag>..HEAD` if a tag exists, otherwise just `HEAD`.

If there are zero commits in the range, stop and tell the user there's nothing to release.

## 2. Suggest a version bump

Read the current version from `package.json` (`node -p "require('./package.json').version"`). Decide a bump level from the commits:
- **major** — breaking changes, removed features, incompatible config/data formats
- **minor** — new user-visible features, capabilities, or commands
- **patch** — bug fixes, internal refactors, doc/test/CI changes only

Tell the user: current version, suggested next version, one short rationale (≤1 sentence). Don't dump the full commit log.

## 3. Draft release notes

Write user-facing prose grouped by intent in [Keep a Changelog](https://keepachangelog.com/) style. Only include sections that have content:

```
## What's new in v<X.Y.Z>

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Rules:
- Group by *what changed for the user*, not by commit subject. Multiple commits often collapse into one bullet.
- Skip noise: lockfile bumps, CI tweaks, internal-only refactors that don't change behavior, formatting/typo commits.
- One short sentence per bullet. No commit hashes. No "by @username".
- If a commit subject already reads as a user-facing change, you can use it largely as-is.

Write the draft to a temp file. Get the path with `node -p "require('path').join(require('os').tmpdir(), 'modmixer-release-notes.md')"` and use that absolute path with the Write tool. Remember the path — you'll pass it to the script in step 5.

## 4. Confirm with the user

Show the user the version + bump + draft notes inline. Ask:

> Ship as `v<X.Y.Z>` with these notes? (yes / edit / cancel)

- **yes** → proceed.
- **edit** → ask what to change, update the temp file, show the new version, ask again.
- **cancel** → stop. Don't run anything else.

## 5. Run the release script

Once confirmed, run:

```
node scripts/release.mjs --notes-file "<path-from-step-3>" --<bump>
```

Where `<bump>` is `major`, `minor`, or `patch` matching what the user confirmed.

The script will:
1. Run lint / typecheck / test.
2. Bump version in `package.json` + `package-lock.json`.
3. Commit `Release vX.Y.Z`, tag, push main and tag.
4. Find and watch the GitHub Actions release workflow (~10–15 min).
5. Overwrite the release body in `lebek/modmixer` with the curated notes.

Stream the script's output so the user sees build progress.

## 6. Report

When the script finishes:
- **Success**: print the final release URL the script logged.
- **Failure**: tell the user which step failed (preflight / build / notes edit) and link the relevant URL. Don't try to fix it automatically — the user decides whether to revert, retry, or hand-edit the release.

## Notes on edge cases

- If preflight fails (dirty tree, not on main, lint/test failures): nothing was tagged or pushed. The user fixes the issue and re-runs `/release`.
- If the build fails: the tag and version-bump commit exist. Don't auto-revert. Tell the user the run URL; they can re-run the workflow from the Actions UI after pushing a fix, or revert with `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` followed by `git revert HEAD`.
- If `gh` complains about auth: tell the user to run `gh auth login` (interactive — they need to do it themselves).
