import { useMemo, useState } from 'react';
import { sanitizeAuthorHandle } from '@/lib/identifiers';
import { useAsyncAction } from '@/lib/use-async-action';
import { OnboardingStep } from '../onboarding-shell';

export function AuthorStep({
  stepIndex,
  total,
  defaultAuthor,
  onSaved,
  onBack,
}: {
  stepIndex: number;
  total: number;
  defaultAuthor: string;
  onSaved: () => void;
  onBack: () => void;
}) {
  const [author, setAuthor] = useState(defaultAuthor);
  const preview = useMemo(() => sanitizeAuthorHandle(author), [author]);

  const save = useAsyncAction(async () => {
    await window.modmixer.setDefaultAuthor(author);
    onSaved();
  });

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Author handle"
      title="Pick an author handle"
      subtitle="Modmixer prefixes your mods' package IDs with this handle so they don't collide with other authors' packages."
      canContinue={!!preview && !save.busy}
      continueLabel={save.busy ? 'Saving…' : 'Get started'}
      onContinue={() => preview && void save.run()}
      onBack={onBack}
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Author handle
          </span>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
            placeholder="petersmith"
            autoFocus
          />
        </label>
        <p className="text-xs text-muted">
          Your mods will get package IDs like{' '}
          <code className="font-mono text-[11px] text-ink">
            {preview || 'author'}.ModName
          </code>
          . You can change this later in Settings.
        </p>
        {save.error && <p className="text-sm text-failed">{save.error}</p>}
      </div>
    </OnboardingStep>
  );
}
