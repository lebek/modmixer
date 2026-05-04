---
description: Cut a signed tester build via GitHub Actions and locate the installer to share with a remote tester.
allowed-tools: Bash, Read
---

# /tester-build

You are running the `/tester-build` command. Walk through these steps in order. Be concise — one sentence per step at most. Do not narrate plans; just do the work.

## 1. Check working tree

Run `git status --porcelain`. If it has any output, tell the user the tree is dirty (show what's changed) and stop. The build runs from the committed branch state — uncommitted changes wouldn't be tested.

## 2. Confirm target

Default is `win-x64` (covers most testers). Ask:

> Build for which target? (win-x64 / win-arm64 / all) [default: win-x64]

Accept these answers:
- empty / `yes` / `default` → `win-x64`
- `win-x64`, `win-arm64`, `all` → use as-is
- anything else → ask again

`all` builds every matrix entry but takes the same wall-clock time (parallel runners) and downloads both Windows installers.

## 3. Run the script

Run:

```
node scripts/tester-build.mjs --target <target>
```

Stream output so the user sees progress. The script will:
1. Verify `gh` is authed.
2. Push the current branch if it has unpushed commits.
3. `gh workflow run release.yml --ref <branch>` to dispatch.
4. Poll for the new run, then `gh run watch` it (~10–15 min).
5. Download the artifact to `out/tester-build/<run-id>/<target>/`.
6. Print the path to the Setup.exe and the run URL.

## 4. Report

When the script finishes:

- **Success**: print the absolute path(s) to the Setup.exe and the run URL. Remind the user that Discord's 25 MB free / 50 MB Nitro upload cap means they'll need a file host (Drive, WeTransfer) for the ~150-200 MB installer, or share the GitHub artifact link if the tester has repo read access.
- **Failure**: print the run URL the script logged. Don't try to fix it automatically — the user decides whether to retry, edit code and re-dispatch, or check signing config.

## Notes on edge cases

- If `gh` complains about auth: tell the user to run `gh auth login` (interactive — they need to do it themselves).
- If the user is on `main` and wants to test an unmerged change, they should switch to a feature branch first. `/tester-build` always dispatches against the current branch.
- The signed installer is a real Squirrel `.exe` — testers won't see SmartScreen warnings (Trusted Signing certs are recognized). It installs to `%LOCALAPPDATA%\modmixer\` and self-updates from GitHub Releases, same as a tagged release.
- If the user has Trusted Signing quota concerns, mention that each tester build burns a small amount of quota (sign operations per day are limited).
