import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { GameId, SetupAction, SetupRequirement } from '@/agent/games/types';
import type { GameSetupView } from './use-game-setup';

/**
 * The shared, game-neutral core of "set up a game": the prerequisite checks
 * followed by the code-index build. All THREE setup surfaces render this — the
 * onboarding Setup step, the pre-chat GameSetupGate, and the Settings → Games
 * card — differing only in their surrounding chrome and the small policy flags
 * below. One component is the single place setup is rendered, so the checks +
 * indexing are robust once.
 *
 * Purely presentational given a `view` from useGameSetup (the chrome owns the
 * hook so it can read `allClear`/`requirementsSatisfied` for its own gating);
 * the only behavior it owns is auto-kicking the build per `autoBuild`.
 */
export function GameSetupBody({
  game,
  view,
  autoBuild,
  requirementsFilter,
  showRebuild = false,
}: {
  game: GameId;
  view: GameSetupView;
  /**
   * When to auto-kick a build once prerequisites pass. Onboarding passes
   * `{absent:true, stale:true}` (reaching the step means setup); the gate passes
   * `{absent:modOpen, stale:true}` so a plain library lens-switch doesn't build;
   * Settings passes `{absent:false, stale:false}` — it lists every game, so it
   * must never auto-start a heavy build; the user triggers it with the button.
   */
  autoBuild: { absent: boolean; stale: boolean };
  /** Show every check (onboarding/Settings) or only the unmet ones (the gate). */
  requirementsFilter: 'all' | 'unmet';
  /** Offer a manual (force) rebuild button — the Settings card's "redo". */
  showRebuild?: boolean;
}) {
  const {
    snapshot,
    latest,
    building,
    blocked,
    phaseLabel,
    fraction,
    rebuild,
    requirements,
    requirementsSatisfied,
    recheckRequirements,
  } = view;

  // Auto-kick the build once prerequisites pass and the index is absent/stale.
  // Guarded per-game so it fires once, not on every progress re-render.
  const state = snapshot?.status.state ?? null;
  const triggered = useRef<GameId | null>(null);
  useEffect(() => {
    const wantBuild =
      requirementsSatisfied &&
      ((state === 'stale' && autoBuild.stale) ||
        (state === 'absent' && autoBuild.absent));
    if (wantBuild && triggered.current !== game) {
      triggered.current = game;
      rebuild(false);
    }
    if (state === 'fresh') triggered.current = null;
  }, [game, state, requirementsSatisfied, autoBuild.absent, autoBuild.stale, rebuild]);

  // When the build finishes it has just provisioned any `auto` toolchain (JDK,
  // .NET), so re-probe once so those rows flip from "will install" to
  // "provisioned ✓". Guarded so it fires once per fresh transition.
  const rechecked = useRef<GameId | null>(null);
  useEffect(() => {
    if (state === 'fresh' && rechecked.current !== game) {
      rechecked.current = game;
      void recheckRequirements();
    }
    if (state !== 'fresh') rechecked.current = null;
  }, [game, state, recheckRequirements]);

  const isAuto = (r: SetupRequirement) => (r.provisioning ?? 'manual') === 'auto';
  const rows = (requirements?.items ?? []).filter((r) => {
    if (requirementsFilter === 'all') return true;
    // The gate's 'unmet' view shows only manual checks the user must act on —
    // auto rows are the build's job, so they never appear as a blocker there.
    return !r.ok && !isAuto(r);
  });
  const hasUnmetRequired = (requirements?.items ?? []).some(
    (r) => r.severity === 'required' && !isAuto(r) && !r.ok,
  );
  const isError = latest?.type === 'error' && !building;
  // Prefer the granular step message ("Downloading the .NET SDK…") over the
  // static phase title, so toolchain provisioning during setup is legible and
  // a long step never looks like an unexplained hang.
  const buildLine = latest?.type === 'phase' ? latest.message : phaseLabel;
  const canForceRebuild =
    showRebuild && !building && (snapshot?.status.canRebuild ?? false);

  return (
    <div className="space-y-4">
      {!requirements && <p className="text-sm text-muted">Checking…</p>}

      {rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <RequirementRow
              key={r.id}
              req={r}
              onRecheck={recheckRequirements}
            />
          ))}
        </div>
      )}

      {/* Index — only meaningful once the required prerequisites pass. */}
      {requirements && requirementsSatisfied && !snapshot && (
        <p className="text-sm text-muted">Loading…</p>
      )}
      {requirements && requirementsSatisfied && snapshot && (
        <div className="rounded-md border border-line bg-surface/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <p
              className={
                'font-mono text-[10px] uppercase tracking-[0.18em] ' +
                indexLabelTone(state, isError)
              }
            >
              {indexLabel(state, isError)}
            </p>
            {isError ? (
              <ActionButton onClick={() => rebuild(true)}>Retry</ActionButton>
            ) : canForceRebuild ? (
              <ActionButton onClick={() => rebuild(true)}>
                {snapshot.status.rebuildLabel}
              </ActionButton>
            ) : null}
          </div>

          {blocked && (
            <p className="mt-2 text-sm text-ink">
              {snapshot.status.blockedReason ?? snapshot.status.headline}
            </p>
          )}

          {building && buildLine && (
            <p className="mt-2 text-sm text-ink">{buildLine}</p>
          )}
          {building && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-paper">
              <div
                className="h-full bg-accent transition-all"
                style={{
                  width:
                    fraction !== null ? `${Math.max(2, fraction * 100)}%` : '40%',
                  animation:
                    fraction === null
                      ? 'indexIndeterminate 1.4s linear infinite'
                      : undefined,
                }}
              />
            </div>
          )}

          {isError && latest?.type === 'error' && (
            <p className="mt-3 text-xs text-failed">{latest.message}</p>
          )}

          {/* Idle + never-built / out-of-date → explain (Settings, no auto-build). */}
          {!building && !blocked && !isError && (state === 'absent' || state === 'stale') && (
            <p className="mt-2 text-sm text-muted">{snapshot.status.headline}</p>
          )}

          {!building && snapshot.status.facts.length > 0 && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {snapshot.status.facts.map((f) => (
                <Fragment key={f.label}>
                  <dt className="text-muted">{f.label}</dt>
                  <dd className="font-mono text-xs text-ink">{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      )}

      {/* Required checks unmet → the build can't start; say so plainly. */}
      {requirements && hasUnmetRequired && (
        <p className="text-xs leading-relaxed text-muted">
          Complete the required checks above to build the code index.
        </p>
      )}
    </div>
  );
}

/**
 * One prerequisite row. Maps the requirement's structured `action` onto an
 * existing IPC (the adapter is main-only and can't hand us a callback) and
 * re-checks afterward so the row flips green without a manual refresh.
 */
function RequirementRow({
  req,
  onRecheck,
}: {
  req: SetupRequirement;
  onRecheck: () => Promise<void>;
}) {
  const action = req.action;
  const runAction = async (action: SetupAction) => {
    // Dispatch on the action kind, never the game id, so this stays game-neutral
    // (Minecraft emits no actions; only RimWorld surfaces these today).
    switch (action.kind) {
      case 'browse-install':
        await window.modmixer.browseRimWorldInstall();
        break;
      case 'launch-game':
        await window.modmixer.launchRimWorld();
        break;
      case 'open-url':
        if (action.url) void window.modmixer.openExternal(action.url);
        return; // External install — nothing to re-check synchronously.
    }
    await onRecheck();
  };

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-line bg-surface/40 px-3 py-2">
      <CheckIcon tone={iconTone(req)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-sm font-medium text-ink">
              {req.label}
            </span>
            {req.ok && req.hint && (
              <span className="truncate font-mono text-[11px] text-muted">
                {req.hint}
              </span>
            )}
          </div>
          {action && (
            <div className="shrink-0">
              <ActionButton onClick={() => void runAction(action)}>
                {action.label}
              </ActionButton>
            </div>
          )}
        </div>
        {req.detail && !req.ok && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{req.detail}</p>
        )}
      </div>
    </div>
  );
}

/** Short status word for the index card, shared across all three surfaces. */
function indexLabel(state: string | null, isError: boolean): string {
  if (isError) return 'Failed';
  switch (state) {
    case 'building':
      return 'Building';
    case 'fresh':
      return 'Index ready';
    case 'stale':
      return 'Update available';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Not set up';
  }
}

function indexLabelTone(state: string | null, isError: boolean): string {
  if (isError) return 'text-failed';
  switch (state) {
    case 'building':
      return 'text-accent';
    case 'fresh':
      return 'text-ready';
    case 'stale':
      return 'text-warning';
    default:
      return 'text-muted';
  }
}

type IconTone = 'ok' | 'pending' | 'warn' | 'fail';

/**
 * ok → green check. Otherwise a dot: `pending` (accent) for an auto-provisioned
 * row the build will handle, `fail` (red) for an unmet required manual check,
 * `warn` (amber) for an unmet recommended one.
 */
function iconTone(req: SetupRequirement): IconTone {
  if (req.ok) return 'ok';
  if ((req.provisioning ?? 'manual') === 'auto') return 'pending';
  return req.severity === 'required' ? 'fail' : 'warn';
}

function CheckIcon({ tone }: { tone: IconTone }) {
  const ring = {
    ok: 'border-ready/60 bg-ready/10 text-ready',
    pending: 'border-accent/50 bg-accent/10 text-accent',
    warn: 'border-warning/60 bg-warning/10 text-warning',
    fail: 'border-failed/60 bg-failed/10 text-failed',
  }[tone];
  const dot = { pending: 'bg-accent', warn: 'bg-warning', fail: 'bg-failed' };
  return (
    <span
      aria-hidden
      className={
        'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ' +
        ring
      }
    >
      {tone === 'ok' ? (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-2.5 w-2.5"
        >
          <path
            d="M2.5 6.5l2.5 2.5 4.5-5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span className={'h-1.5 w-1.5 rounded-full ' + dot[tone]} />
      )}
    </span>
  );
}

function ActionButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
