import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  PathPolicyError,
  assertCommandAllowed,
  assertPathAllowed,
  type PathPolicyRoots,
} from '../path-policy.js';

const HOME = homedir();

const ROOTS: PathPolicyRoots = {
  workspaceDir: path.join(HOME, 'Library/Application Support/Modmixer/workspace/Mods'),
  managedDir: path.join(
    HOME,
    'Library/Application Support/Steam/steamapps/common/RimWorld/RimWorldMac.app/Contents/Resources/Data/Managed',
  ),
  dataDir: path.join(
    HOME,
    'Library/Application Support/Steam/steamapps/common/RimWorld/RimWorldMac.app/Data',
  ),
  workshopDir: path.join(
    HOME,
    'Library/Application Support/Steam/steamapps/workshop/content/294100',
  ),
  rimworldModsDir: path.join(
    HOME,
    'Library/Application Support/Steam/steamapps/common/RimWorld/RimWorldMac.app/Mods',
  ),
  playerLogDir: path.join(
    HOME,
    'Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios',
  ),
  indexDir: path.join(HOME, 'Library/Application Support/Modmixer/index'),
  cookbookDir: path.join(HOME, 'Library/Application Support/Modmixer/cookbook'),
  userSkillsDir: path.join(HOME, '.modmixer/skills'),
  minecraftRoots: [
    path.join(HOME, 'Library/Application Support/Modmixer/toolchain'),
    path.join(HOME, '.gradle'),
    path.join(HOME, '.neoformruntime'),
  ],
};

describe('assertPathAllowed', () => {
  it('accepts a workspace path', () => {
    const ok = path.join(ROOTS.workspaceDir, 'MyMod/Source/MyMod.csproj');
    assert.equal(assertPathAllowed(ok, ROOTS, 'dllPath'), ok);
  });

  it('accepts the RimWorld Managed/ Assembly-CSharp.dll', () => {
    const ok = path.join(ROOTS.managedDir!, 'Assembly-CSharp.dll');
    assert.equal(assertPathAllowed(ok, ROOTS), ok);
  });

  it('accepts a Workshop subscription path', () => {
    const ok = path.join(ROOTS.workshopDir!, '12345/Assemblies/Foo.dll');
    assert.equal(assertPathAllowed(ok, ROOTS), ok);
  });

  it('accepts a canonical DLC-pack def XML under dataDir', () => {
    const ok = path.join(ROOTS.dataDir!, 'Core/Defs/RecipeDefs/Recipes_Meals.xml');
    assert.equal(assertPathAllowed(ok, ROOTS), ok);
  });

  it('accepts a cookbook section path', () => {
    const ok = path.join(ROOTS.cookbookDir, 'ce-compat/ranged-weapons.md');
    assert.equal(assertPathAllowed(ok, ROOTS), ok);
  });

  it('accepts a Minecraft toolchain / Gradle-cache path', () => {
    const jdk = path.join(ROOTS.minecraftRoots[0], 'jdk-21/bin/java');
    assert.equal(assertPathAllowed(jdk, ROOTS), jdk);
    const dep = path.join(
      ROOTS.minecraftRoots[1],
      'caches/modules-2/files-2.1/net.neoforged/neoforge/sources.jar',
    );
    assert.equal(assertPathAllowed(dep, ROOTS), dep);
  });

  it('accepts a SKILL.md under the user skills dir', () => {
    const ok = path.join(ROOTS.userSkillsDir!, 'my-skill/SKILL.md');
    assert.equal(assertPathAllowed(ok, ROOTS), ok);
  });

  it('rejects a sibling file in ~/.modmixer outside the skills subtree', () => {
    // AGENTS.md is read by Modmixer at prompt-build, never by the agent —
    // only the skills/ subtree is allowlisted.
    const outside = path.join(HOME, '.modmixer/AGENTS.md');
    assert.throws(
      () => assertPathAllowed(outside, ROOTS),
      (err: unknown) =>
        err instanceof PathPolicyError && err.kind === 'allowlist',
    );
  });

  it('handles a null userSkillsDir', () => {
    const noSkills: PathPolicyRoots = { ...ROOTS, userSkillsDir: null };
    assert.throws(
      () =>
        assertPathAllowed(
          path.join(HOME, '.modmixer/skills/my-skill/SKILL.md'),
          noSkills,
        ),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects /etc/passwd', () => {
    assert.throws(
      () => assertPathAllowed('/etc/passwd', ROOTS),
      (err: unknown) =>
        err instanceof PathPolicyError && err.kind === 'allowlist',
    );
  });

  it('rejects ~/.ssh/id_rsa via denylist', () => {
    assert.throws(
      () => assertPathAllowed('~/.ssh/id_rsa', ROOTS),
      (err: unknown) =>
        err instanceof PathPolicyError && err.kind === 'denylist',
    );
  });

  it('rejects path traversal escaping the workspace', () => {
    const traversal = path.join(ROOTS.workspaceDir, '../../../etc/passwd');
    assert.throws(
      () => assertPathAllowed(traversal, ROOTS),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects an absolute path that resembles a workspace prefix but is outside', () => {
    // /Users/x/Library/Application Support/Modmixer/workspace/Mods vs
    // /Users/x/Library/Application Support/Modmixer/workspace/ModsBackup
    const sneaky = `${ROOTS.workspaceDir}Backup/something.dll`;
    assert.throws(
      () => assertPathAllowed(sneaky, ROOTS),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects a Keychains path even if cwd is workspace', () => {
    assert.throws(
      () =>
        assertPathAllowed(
          path.join(HOME, 'Library/Keychains/login.keychain-db'),
          ROOTS,
        ),
      (err: unknown) =>
        err instanceof PathPolicyError && err.kind === 'denylist',
    );
  });

  it('handles a null managedDir (RimWorld not installed)', () => {
    const noManaged: PathPolicyRoots = { ...ROOTS, managedDir: null };
    assert.throws(
      () =>
        assertPathAllowed(
          path.join(
            HOME,
            'Library/Application Support/Steam/steamapps/common/RimWorld/RimWorldMac.app/Contents/Resources/Data/Managed/Assembly-CSharp.dll',
          ),
          noManaged,
        ),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });
});

describe('assertCommandAllowed', () => {
  it('allows a benign workspace command', () => {
    assert.doesNotThrow(() => assertCommandAllowed('ls -la Source'));
    assert.doesNotThrow(() =>
      assertCommandAllowed('grep -r "MyDef" --include "*.xml" .'),
    );
    assert.doesNotThrow(() =>
      assertCommandAllowed('dotnet build Source/MyMod.csproj'),
    );
  });

  it('rejects cat ~/.ssh/id_rsa', () => {
    assert.throws(
      () => assertCommandAllowed('cat ~/.ssh/id_rsa'),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects cp ~/Library/Keychains/login.keychain-db .', () => {
    assert.throws(
      () =>
        assertCommandAllowed('cp ~/Library/Keychains/login.keychain-db .'),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects an absolute /Users/x/.aws path', () => {
    assert.throws(
      () =>
        assertCommandAllowed(
          'cat /Users/someone/.aws/credentials',
        ),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('rejects security find-generic-password', () => {
    assert.throws(
      () =>
        assertCommandAllowed(
          'security find-generic-password -s AnthropicCLI',
        ),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('does not falsely reject a path that contains "ssh" but is not /.ssh/', () => {
    assert.doesNotThrow(() =>
      assertCommandAllowed('grep ssh Source/MyMod.csproj'),
    );
  });

  it('rejects bash invocations of ilspycmd and points at decompile_dll', () => {
    assert.throws(
      () => assertCommandAllowed('ilspycmd /path/to/Some.dll'),
      (err: unknown) =>
        err instanceof PathPolicyError &&
        /decompile_dll/.test(err.message),
    );
    assert.throws(
      () => assertCommandAllowed('ilspycmd -t SomeType /path/to/Some.dll'),
      (err: unknown) => err instanceof PathPolicyError,
    );
  });

  it('does not reject substrings that merely contain "ilspycmd"', () => {
    assert.doesNotThrow(() =>
      assertCommandAllowed('grep ilspycmd-notes Source/README.md'),
    );
    assert.doesNotThrow(() =>
      assertCommandAllowed('echo not-ilspycmd-here'),
    );
  });
});
