# Supporting Minecraft Java in Modmixer

*Codebase review and design proposal — June 2026*

This document reviews where RimWorld is wired into Modmixer today, picks a
target for Minecraft Java support (version + loader + toolchain), and proposes
the cleanest path to ship it — with an architecture that makes the *next* game
(or a community-added game) cheaper, without paying for a plugin system now.

---

## 1. Target: Minecraft Java 26.x on Fabric

**Recommendation: latest stable Minecraft Java (26.1.x today, 26.2 lands
June 16, 2026) on the Fabric loader.**

Why Fabric and not NeoForge:

- **Day-one latest-version support.** Fabric ships support for new Minecraft
  versions on release day; NeoForge was still on snapshot builds for 26.1
  months after release. Since the brief is "latest version," Fabric is the
  only loader that reliably tracks it.
- **The toolchain just got dramatically simpler.** As of 26.1, Mojang ships
  official mappings and Fabric dropped its remapping step entirely: the new
  `net.fabricmc.fabric-loom` Gradle plugin compiles mods directly against
  official Mojang mappings (Loom 1.15 + Gradle 9.4). No Yarn, no
  intermediary remap, no `modImplementation` — plain `implementation`. This
  removes the single biggest historical source of agent-confusing build
  errors in Minecraft modding.
- **Dominant on the newest versions.** NeoForge leads for big legacy content
  mods on the 1.21-era; Fabric dominates mods that target current versions
  (the Modrinth ecosystem, performance/QoL mods, new projects).
- **Lightest runtime.** Fabric loader + Fabric API is a small install, easy
  to provision automatically, and `gradle runClient` gives us a self-contained
  dev client — see §4.3.

Hard requirements this brings: **Java (JDK) 25** (mandatory for 26.x) and
**Gradle** (via per-project wrapper). Both are provisionable without user
interaction — see §4.2.

NeoForge support later slots into the same adapter seam as a sibling
`minecraft-neoforge` adapter (or a loader axis on one `minecraft-java`
adapter); nothing in this proposal blocks it.

---

## 2. Where RimWorld lives in the codebase today

There is **no game abstraction anywhere** — 94 files under `src/` mention
RimWorld — but the coupling is well-localized. Survey by layer:

### 2.1 Agent layer (`src/agent/`)

| Area | Files | Coupling |
| --- | --- | --- |
| System prompt | `system-prompt.ts:299-321` | Head is literally "You are an expert RimWorld modding assistant"; paths block, scaffold rules, test-in-game flow all RimWorld prose. Frozen per conversation (prompt-cache identity). |
| Lore | `lore.ts`, `lore/*.md` | Machinery (two-tier repo/user, topics, `read_lore`/`save_lore`) is game-agnostic; the **content** (~2,500 lines curated RimWorld knowledge) and the topic enum are RimWorld's. |
| Cookbook | `cookbook/{harmony,ce-compat}` | Curated third-party framework docs; RimWorld content, generic mechanism. |
| Tools | `agent-host.ts:134-170` | Generic: `edit/read/write/grep/find/ls/bash` (path-guarded), lore, schematic, SVG/preview rendering. RimWorld-specific: `scaffold_mod`, `build_mod` (dotnet), `run_test_cycle`, `list_installed_mods`, `search_defs`, `read_csharp_symbol`, `search_source`, `decompile_dll`, `monitor_*`. |
| Paths/detection | `paths.ts:179-315` | Steam/install probing, executable names, app id 294100, ModsConfig.xml/Player.log locations — all RimWorld. |
| Game control | `game.ts` | `isRimWorldRunning`/`quitRimWorld`/`launchRimWorld` via pgrep/tasklist + direct exe spawn. |
| Registry | `registry/` | About.xml parser, ModsConfig.xml read/write, load-order autosort — entirely RimWorld's mod model. |
| Index | `index/` | Defs XML walker (`Data/<Pack>/Defs/`), ilspycmd decompile of Assembly-CSharp.dll, tree-sitter-**c-sharp** symbol index, ripgrep over decompiled source. SQLite schema is nearly generic (pack/defType/defName ≈ namespace/registry/identifier). |
| Monitor | `monitor/` | TCP server on 13371, newline-JSON protocol (hello/perf/mods/errors), `ErrorBuffer` batching + attribution. **Protocol and buffering are ~90% game-agnostic**; only field names (`rimworldVersion`, Harmony patch graph) and the C# bridge mod are RimWorld. |
| Bridge | `vendor/modmixer-bridge/`, `bridge-install.ts` | Harmony-patched C# mod junctioned into RimWorld's Mods/. |
| Publish | `workshop.ts`, `workshop-publish-host.ts` | Steamworks in a utilityProcess, app id 294100, PublishedFileId.txt. |
| Workspace | `workspace.ts` | Folder layout + symlink-into-game sync is generic in shape; About.xml reading and `modsDir` target are RimWorld. |

### 2.2 Main process (`src/main/`)

Routes split cleanly: `settings/conversations/attachments/snapshots` are
game-agnostic; `lifecycle` (install detection), `mods` (launch/sync/enable),
`registry-routes`, `assets` (Workshop publish), `system` (index/monitor) carry
the game coupling. `RouteContext` is a good seam — adapters can hang off it.

### 2.3 Data model — the important gap

**Nothing stores a game id.** `Conversation.scope` is
`{type:'mod', modFolder} | {type:'new'}`; `WorkspaceMod` has no game field;
settings has a single `rimworldInstallOverride`. Game identity is implicit
("everything is RimWorld"). This is the first thing to fix, and the cheapest
to fix *now* while there's only one game to migrate.

### 2.4 Renderer (`src/components/`)

RimWorld strings/flows in ~17 components: onboarding steps (`rimworld.tsx`,
`index.tsx` are game-specific; consent/AI/author are not), `mod-header.tsx`
("Launch in RimWorld"), `library-view.tsx` (load order, ModsConfig semantics,
Workshop source), `mod-publish-panel.tsx` (Steam Workshop only),
`monitor-view.tsx` (Harmony patch panels, "rw {version}").

### 2.5 Packaging (`forge.config.ts`)

`extraResource` ships RimWorld-specific payloads: ilspycmd (~30-50 MB),
tree-sitter-c-sharp wasm, the staged bridge mod, `lore/`, `cookbook/`.
Pattern to copy: heavyweight per-game tools are **fetched on demand**
(`fetch-ilspycmd.mjs`) or staged per-platform — the JDK should follow the
fetch-on-demand route, not ship in the installer.

---

## 3. Proposed architecture: `GameAdapter`

One interface, two implementations (`rimworld`, `minecraft-java`), living in
a new `src/games/` tree. Every coupling point in §2 becomes a call through
the adapter. Capability flags keep the interface honest where games genuinely
differ, instead of forcing fake symmetry.

```ts
// src/games/types.ts (sketch)
export interface GameAdapter {
  id: GameId;                       // 'rimworld' | 'minecraft-java'
  name: string;                     // "RimWorld", "Minecraft (Java)"
  strings: GameStrings;             // "Launch in RimWorld", install-step copy, …

  // Detection & environment
  detectInstall(): Promise<GameInstall | null>;   // + user override per game
  detectEnv(): Promise<EnvReport>;                // .NET/ilspycmd vs JDK/Gradle
  provisionEnv?(onProgress): Promise<void>;       // e.g. download JDK 25

  // Projects
  scaffold(opts: ScaffoldOpts): Promise<void>;    // About.xml tree vs Fabric template
  readMetadata(dir: string): Promise<ModMetadata>;   // About.xml vs fabric.mod.json
  writeMetadata(dir: string, meta: ModMetadata): Promise<void>;
  idRules: IdRules;                               // packageId vs modid/Maven-ish id

  // Build & test loop
  build(dir: string): Promise<BuildResult>;       // dotnet vs gradle (wrapper)
  testLoop: TestLoopAdapter;                      // launch/quit/isRunning/sync/enable

  // Knowledge & index
  lorePath: string;                               // lore/rimworld/, lore/minecraft-java/
  cookbookPath?: string;
  promptBlocks(scope, ctx): PromptBlocks;         // head/paths/scaffold/test-flow prose
  indexer?: GameIndexer;                          // defs+C# vs registries+Java source

  // Optional capabilities
  registry?: InstalledModsAdapter;                // ModsConfig/load order vs mods-folder scan
  monitor?: MonitorAdapter;                       // bridge protocol semantics
  publishTargets?: PublishTarget[];               // Steam Workshop vs Modrinth
}
```

Design rules that keep this clean:

1. **Adapters are code, content is data.** Strings, prompt prose, scaffold
   templates, lore, and cookbook live in per-game directories
   (`src/games/<id>/`, `lore/<id>/`, `cookbook/<id>/`, `templates/<id>/`).
   The TS adapter wires them up. This is what makes future community game
   packs a packaging problem rather than a rewrite (§7).
2. **Capability flags, not stubs.** Minecraft has no load order; RimWorld has
   no Gradle. UI and agent tools render/register from what the adapter
   declares (`registry?`, `monitor?`, `publishTargets?`), so a thin adapter
   for a future game is *valid*, just less capable.
3. **The agent tool set is assembled per conversation from the adapter.**
   `agent-host.ts` already builds the tool list in one place
   (`buildCustomTools`); it takes the adapter and registers generic tools +
   the adapter's game tools. Tool *names* stay stable and game-neutral where
   semantics match (`scaffold_mod`, `build_mod`, `run_test_cycle`,
   `search_defs`→`search_registry`, `decompile_dll`→`decompile_binary`) so
   lore and prompts transfer.
4. **Generalize shared infrastructure in place rather than forking it**:
   the monitor server/protocol (rename `rimworldVersion`→`gameVersion`, make
   the patch graph an optional channel), the SQLite index schema
   (pack/defType/defName → namespace/kind/identifier), workspace
   sync-by-symlink, snapshots, conversations.

### 3.1 Data model changes (do these first)

- `Conversation.scope` gains `game: GameId` (default `'rimworld'` on load —
  one-line migration in `conversations.ts`).
- Workspace mods get `.modmixer/project.json` with `{ game: GameId }`
  (absence ⇒ rimworld). The schematic sidecar already establishes the
  `.modmixer/` convention.
- Settings: `rimworldInstallOverride: string|null` →
  `installOverrides: Record<GameId, string|null>` (migrate the old key), plus
  per-game setup-completed markers.
- `buildSystemPrompt(scope)` composes from `adapter.promptBlocks()`. Same
  freeze-at-creation caching rule — the game id is part of the conversation,
  so cache identity is unaffected.

---

## 4. Minecraft Java specifics

### 4.1 Project shape

Scaffold from a bundled Fabric template (the `templates/minecraft-java/`
data directory), substituting mod id/name/author:

```
my-mod/
  build.gradle            # net.fabricmc.fabric-loom plugin, Loom 1.15
  gradle/ + gradlew(.bat) # Gradle wrapper — pinned 9.4, self-downloading
  gradle.properties       # minecraft_version, loader_version, mod_version
  src/main/java/<pkg>/    # entrypoint class
  src/main/resources/
    fabric.mod.json       # id, entrypoints, depends (the About.xml analog)
    assets/<modid>/       # textures, lang, models  ← assets pipeline target
    data/<modid>/         # recipes, loot tables — JSON "defs"
```

Notes: `fabric.mod.json` maps cleanly onto the existing `ModMetadata`
abstraction (id/name/description/authors/depends). Mojang-mappings world
means generated code uses real `net.minecraft.*` names — exactly what the
index (§4.4) serves. A big share of Minecraft mod content is *data-driven
JSON* (recipes, loot, advancements, worldgen) + assets — Modmixer's existing
assets pipeline (sprite import, SVG→PNG) is directly reusable for textures.

### 4.2 Toolchain provisioning (onboarding-critical)

- **JDK 25**: probe `JAVA_HOME`/PATH/known launcher locations; if absent,
  download a Temurin/Microsoft OpenJDK 25 archive to
  `userData/toolchains/jdk-25/` with progress UI — same pattern as
  `fetch-ilspycmd.mjs`, but at setup time, not build time. The official
  launcher's bundled runtime is a JRE and can't compile, so don't rely on it.
- **Gradle**: never installed globally — the scaffolded wrapper downloads
  and caches itself. First build is slow (Gradle + Loom + Minecraft
  download); the setup flow should run a priming build with honest progress
  copy ("Setting up the Minecraft toolchain — a few minutes, one time").
- `build_mod` for MC = `./gradlew build` with `JAVA_HOME` pointed at the
  provisioned JDK; parse javac/Loom diagnostics into the same structured
  build-result shape the agent already consumes from dotnet.

### 4.3 Test loop — the key UX decision

Two viable modes; **ship dev-client first**:

1. **Dev client (recommended default): `./gradlew runClient`.** Loom
   launches an isolated Minecraft client with the mod loaded from the
   workspace — no touching the user's `.minecraft`, no launcher, no
   Microsoft auth needed for singleplayer testing, and **we own the
   process**: stdout *is* the game log, so error monitoring needs no bridge
   to reach parity with RimWorld's Player.log watching. The run directory
   (worlds, options) persists under the project, so testers keep their test
   world between iterations.
2. **Production install (phase 2): build jar → copy/symlink into
   `.minecraft/mods/` + Fabric profile via the official launcher.** Needed
   for "test alongside my real mods/world", and for the Library view of the
   user's installed mods. More moving parts (launcher profiles, loader
   installation, auth), so it shouldn't gate the MVP.

`run_test_cycle` semantics translate directly: is-running → quit → build →
launch `runClient` → watch output. Same edge-triggered `ErrorBuffer`, fed
by a log-parser instead of (initially) a TCP bridge. Crash reports land in
`<run>/crash-reports/*.txt` — surface the newest one on abnormal exit.

### 4.4 Knowledge & index (what makes the agent *good*)

RimWorld parity comes from three sources, all with direct MC analogs:

| RimWorld | Minecraft Java equivalent |
| --- | --- |
| Defs XML index (`search_defs`) | **Vanilla registry reports**: `java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports` dumps every block/item/entity/biome id + block-state JSON. Index into the same SQLite (namespace/registry/identifier). |
| ilspycmd decompile of Assembly-CSharp.dll | **Loom `genSources`**: produces full decompiled, Mojang-mapped Minecraft source (Vineflower) per version — *better* than our DIY decompile path; we just index its output. |
| tree-sitter-c-sharp symbol index (`read_csharp_symbol`) | tree-sitter-**java** over genSources output (`read_symbol`). Same fetch script pattern as `fetch-tree-sitter-csharp.mjs`. |
| ripgrep over decompiled source (`search_source`) | Identical — bundled ripgrep pointed at the genSources corpus. |
| `decompile_dll` for other mods | `decompile_jar` via Vineflower (small standalone jar, runs on the provisioned JDK — no new native binaries). |

Index staleness keys off Minecraft version + loader version (analog of the
existing version+DLC fingerprint in `index/rebuild.ts`).

**Lore is the real cost center.** RimWorld ships ~2,500 lines of curated,
hard-won lessons; Minecraft starts at zero. Mitigation: seed
`lore/minecraft-java/` with porting/test-loop/build-failure entries written
during dogfooding, and seed `cookbook/minecraft-java/` from Fabric docs
topics (fabric-api overview, Mixin patterns — the Harmony analog,
data-driven JSON recipes, registries, networking). The community-lore
pipeline already exists and is game-agnostic; give it a game dimension.

### 4.5 Monitoring & bridge (phase 2)

The TCP protocol (`hello/perf/mods/errors`, port 13371, error hashing,
run tracking, attribution) generalizes with minor renames. A Fabric
`modmixer-bridge` mod can stream the same shapes: TPS/MSPT for perf, the
Fabric loader's mod container list for inventory, log4j appender +
stack-attribution for errors, and Mixin info where the Harmony patch graph
sits today. Attribution by mod id from stack frames works the same way.
But because §4.3's dev client gives us stdout, the bridge is an
*enhancement* (perf panel, live mod inventory), not a prerequisite — the
opposite of RimWorld, where the bridge carries error flow.

### 4.6 Publishing

Modrinth, not Steam: `POST /v3/version` multipart upload with a PAT —
dramatically simpler than the Steamworks utilityProcess dance (no native
module, no running-game lock). Make `publishTargets` adapter-declared so the
publish panel renders per-target fields (Modrinth: project slug, loaders,
game versions, channel; Steam: visibility). CurseForge's upload API can be a
second target later. For MVP, even shipping with *export jar + open Modrinth*
is acceptable; the API integration is small enough to include though.

---

## 5. UX design

### 5.1 Onboarding: split "app setup" from "game setup"

Today onboarding hard-gates on RimWorld detection. Restructure:

- **App onboarding (once):** consent → AI provider → author. Game-free.
- **Game setup (per game, on demand):** detection/override → toolchain
  (.NET+ilspycmd / JDK+priming build) → index build. Triggered the first
  time a user starts a project for that game, with per-game completion
  stored in settings.

This is strictly better even for RimWorld-only users (no more wall if the
game isn't installed yet) and is the natural multi-game shape: setting up a
game you never use never happens.

### 5.2 App-level "active game" — a lens, not a mode

Game selection should be app-level state (`activeGame: GameId`, persisted
in settings) — but a *default/lens*, not a hard mode wall. The split:

**Follows `activeGame`:**

- **Library** — fully scoped to it. The library is a view of one game's
  install; a merged multi-game list has no coherent meaning. Switching game
  swaps the whole view (RimWorld keeps load-order/autosort; Minecraft gets
  a simpler enabled/disabled jar list via capability flags).
- **Monitor** — selects which game's bridge/log stream to display.
- **Home** — default-filtered to it, with game badges on workspace mods and
  a cheap "all games" affordance.
- **+ New Mod** — defaults to it (zero extra clicks in the common case);
  the game picker remains as an override, not a gate. The choice stamps
  `game` into the conversation scope and project marker, which selects
  adapter, prompt, and tool set for the life of that project.
- **Per-game setup** — switching to a not-yet-configured game is the entry
  point for that game's setup flow (§5.1).

**Ignores `activeGame`:**

- **Open tabs.** A tab's project carries its own game (frozen into the
  conversation/prompt/tool set), and tabs hold live agent sessions — a
  global switch must never hide or interrupt them. Each tab renders from
  its own adapter (its own launch button, monitor feed, publish targets).
  Focusing a tab of another game does *not* silently flip `activeGame`
  (silent mode flips are the classic mode-error source); switching is
  manual.

Two rules keep this clean:

1. **The switcher doesn't exist until it matters.** With one game set up
   there is no switcher and the UI looks exactly like today; it appears in
   the header only once a second game is configured.
2. **`activeGame` is a UI convenience, not plumbing.** Hold it in renderer/
   app state (persisted via settings), but keep IPC routes and the agent
   layer explicitly parameterized by game — conversations already carry
   their game id. If the main process reads ambient global game state, the
   implicit "everything is RimWorld" assumption has just been rebuilt with
   a variable.

### 5.3 Everything else follows the adapter

- **Tabs/Build view:** per-tab game badge; header button text from
  `adapter.strings` ("Launch in Minecraft"); test prompt template from the
  adapter.
- **Monitor:** status bar reads `gameVersion`; panels render per declared
  monitor capabilities (perf/patches/errors). MC MVP shows the errors panel
  fed by log parsing; perf/Mixin panels arrive with the bridge. The MC
  library view can ship after the MVP since the dev client doesn't need it.
- **Publish:** panel renders the adapter's targets; metadata section edits
  `ModMetadata` (writing About.xml or fabric.mod.json underneath).

---

## 6. Phasing

**Phase 0 — seam (no behavior change).** Introduce `GameAdapter`, move
existing RimWorld code behind `src/games/rimworld/` mechanically; add
`game` to scope/projects/settings with rimworld defaults; relocate lore →
`lore/rimworld/`, cookbook → `cookbook/rimworld/` (update extraResource +
prompt paths). Ship this inside a normal release; if nothing regresses, the
seam is right.

**Phase 1 — Minecraft Java MVP.** Fabric template + scaffold; JDK
provisioning + priming build; `build_mod` via Gradle; `runClient` test loop
with stdout/crash-report error flow into the existing ErrorBuffer; index =
registry reports + genSources + tree-sitter-java + ripgrep; MC prompt
blocks + seed lore/cookbook; game picker + per-game setup UX; Modrinth
publish (or export-jar fallback). **This is "Minecraft Java today": create →
chat → build → test-in-game → fix-from-errors → publish.**

**Phase 2 — depth.** Fabric bridge mod on the generalized TCP protocol
(perf + mod inventory + richer attribution); production `.minecraft`
install + launcher profile flow; MC library view; lore expansion from
dogfooding + community lore; CurseForge target; NeoForge adapter when
demand shows up.

Biggest schedule risks, in order: lore/knowledge quality (content, not
code — start dogfooding early), first-run toolchain time (mitigate with the
priming build + honest progress UI), Gradle/Loom diagnostic parsing edge
cases.

---

## 7. Future games & user-added games

The adapter keeps future *first-party* games cheap: each is a
`src/games/<id>/` module + content directories, with shared monitor/index/
workspace/publish infrastructure already generalized.

For *user-added* games, don't build a plugin system now — but this design
makes one tractable later because an adapter is mostly **declarative
content** (strings, templates, prompt prose, lore, cookbook, detection
hints) around a small code core. The realistic path is a tiered "game pack"
format:

- **Tier 0 (declarative-only):** manifest with install-detection globs,
  launch command, log file pattern + error regexes, scaffold template,
  prompt prose, lore/cookbook dirs. Gets you: project management, chat with
  game knowledge, launch-and-watch-logs testing. No code execution, so
  community packs are safe to share.
- **Tier 1+ (code):** indexer, bridge, publish integrations — first-party
  or vetted only.

The discipline that keeps Tier 0 viable is rule 1 from §3: every time we
implement something for Minecraft, prefer data the adapter *reads* over
logic the adapter *is*.
