# instructions for agents writing docs

These docs are published to https://modmixer.com/docs by a build step in the
`modmixer.com` repo. Source of truth lives here in `modmixer/docs/`.

## when to update

When you change behavior in `src/` that a user can observe, update the
matching doc in the same commit. Examples:

- Changed where mods are written → update `install.md` and `first-mod.md`.
- Added a new field to the create form → update `first-mod.md`.
- Added a new diagnostic in the log reader → update `troubleshooting/logs.md`.

If no doc covers the surface, add one and reference it from `meta.json`.

## style

- Lowercase headings (`# first mod`, not `# First Mod`). Matches the site.
- Short sentences. No marketing voice. Assume a player who knows RimWorld.
- Code blocks use language tags (` ```ts `, ` ```xml `, ` ```bash `).
- Never mention "pi" or internal scaffolding. The product is "modmixer".
- Don't add a Co-Authored-By trailer when committing.

## frontmatter

Every page needs:

```yaml
---
title: short page title
description: one sentence used for search snippets and meta tags
---
```

## sidebar

`meta.json` controls section order and page order. New pages must be listed
there or they won't appear in the nav.

## what NOT to do

- Don't add screenshots unless they're in `docs/_images/` — the website's
  build copies that folder. Random asset paths break in production.
- Don't link to localhost or to internal Notion docs.
- Don't duplicate API reference that's auto-generated elsewhere.
