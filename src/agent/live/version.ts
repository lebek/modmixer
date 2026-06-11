// Dotted-version comparison for the Live mod's About.xml <modVersion>.
// Electron-free on purpose so unit tests can import it directly.

/**
 * Compare two dotted numeric versions ("0.2.0" vs "0.10"). Returns -1/0/1.
 * Missing segments count as 0 ("1.5" === "1.5.0"); non-numeric segments
 * count as 0, so a garbage version compares as older than any real one.
 */
export function compareDottedVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
