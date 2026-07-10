import { useState } from 'react';
import {
  CUSTOM_LICENSE_ID,
  LICENSE_OPTIONS,
  findLicense,
  isKnownLicense,
} from '../../agent/licenses';

/**
 * Shared license picker for both publish flows (RimWorld → Steam, Minecraft →
 * Modrinth). A curated dropdown of open licenses plus an "Other…" free-text
 * escape hatch for any other SPDX id — or a blank one, to ship with no license.
 *
 * Controlled by `value` (an SPDX id; '' means no license). The host wraps it in
 * its own labelled Field and passes matching input styling via `className`.
 */
export function LicensePicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  // "Other" mode: the value is a custom SPDX id (or blank). Seeded from the
  // incoming value; these pickers remount on dialog-open / mod-switch, so this
  // stays in sync with the value the host reseeds.
  const [custom, setCustom] = useState(() => !isKnownLicense(value));

  const active = custom ? undefined : findLicense(value);

  return (
    <div className="space-y-1.5">
      <select
        value={custom ? CUSTOM_LICENSE_ID : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_LICENSE_ID) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
        className={className}
      >
        {LICENSE_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        <option value={CUSTOM_LICENSE_ID}>Other (SPDX id, or none)…</option>
      </select>

      {custom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="e.g. GPL-3.0-only — leave blank for no license"
          className={className}
        />
      )}

      <p className="text-xs text-muted">
        {custom
          ? 'Enter an SPDX license id, or leave blank to ship with no license.'
          : active?.blurb}
      </p>
    </div>
  );
}
