// One-off script: read shipped lore/*.md, split into entries, and emit a
// SQL INSERT for the community_lore Supabase table. Pipe the output into
// `psql` or paste into the SQL editor / Supabase MCP execute_sql.
//
// Usage: node scripts/seed-community-lore.mjs > seed.sql

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LORE_DIR = path.resolve(__dirname, '..', 'lore');

function splitEntries(md) {
  const lines = md.split('\n');
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) {
        entries.push({
          hook: current.hook,
          markdown: current.lines.join('\n').trimEnd(),
        });
      }
      current = { hook: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    entries.push({
      hook: current.hook,
      markdown: current.lines.join('\n').trimEnd(),
    });
  }
  return entries;
}

function sqlLiteral(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

const rows = [];
for (const file of fs.readdirSync(LORE_DIR).sort()) {
  if (!file.endsWith('.md')) continue;
  const topic = file.replace(/\.md$/, '');
  const md = fs.readFileSync(path.join(LORE_DIR, file), 'utf8');
  for (const e of splitEntries(md)) {
    rows.push({ topic, hook: e.hook, markdown: e.markdown });
  }
}

const values = rows
  .map(
    (r) =>
      `  (${sqlLiteral(r.topic)}, ${sqlLiteral(r.hook)}, ${sqlLiteral(r.markdown)})`,
  )
  .join(',\n');

process.stdout.write(`-- ${rows.length} entries from shipped lore/\n`);
process.stdout.write(
  `insert into public.community_lore (topic, hook, markdown) values\n${values}\non conflict (topic, hook) do update set markdown = excluded.markdown, updated_at = now();\n`,
);
