# Contributing

Thanks for your interest in `@laboverwire/stitch`. This is a small, focused library — contributions are welcome, and a few conventions keep things tidy.

## Before you open a PR

- **Bug fixes:** open a PR directly. Reference an issue if one exists.
- **New features or behavior changes:** open an issue first to discuss the design. Saves wasted work if the direction doesn't fit.
- **Doc-only changes:** PR directly.

## Dev setup

```bash
git clone https://github.com/LabOverWire/stitch.git
cd stitch
npm install
```

The package is consumed as raw TypeScript via Vite aliases inside the `examples/` apps; there is no separate watch mode.

## Local checks

Before pushing, run:

```bash
npm run check
```

That runs `type-check`, `lint`, `format:check`, and `test`. CI runs the same on Node 20 and 22.

If lint or formatting flags issues:

```bash
npm run lint:fix
npm run format
```

## Commit messages

- One line, lowercase start, no prefixes (`feat:`, `fix:`, etc.), no trailing period.
- Describe the change, not the reason. Reasons go in the PR description.
- Examples: `add offline queue consolidation`, `fix race in scope replace`, `update README install instructions`.

## CHANGELOG

User-visible changes go under `## Unreleased` in [`CHANGELOG.md`](../CHANGELOG.md). Internal refactors that don't change behavior don't need an entry.

`npm run release:check` enforces that `## Unreleased` is non-empty before a release can be cut.

## PR checklist

- [ ] `npm run check` passes locally
- [ ] CHANGELOG updated under `## Unreleased` (if user-visible)
- [ ] Docs updated (`docs/`, `README.md`, or `ARCHITECTURE.md`) if behavior changed
- [ ] PR description explains *why*, not just *what*

## Architecture

Read [`ARCHITECTURE.md`](../ARCHITECTURE.md) before touching the layer composition (memory store, persistence, remote sync, offline queue). The layering is intentional and most "small" changes there have non-obvious blast radius.

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](./SECURITY.md).
