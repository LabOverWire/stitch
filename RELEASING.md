# Releasing

`@laboverwire/stitch` is `private: true` and not published to npm. Releases are git tags on `main`. Consumers pin by tag or sha.

## Cut a release

1. **Start from a clean `main`:**
   ```bash
   git checkout main
   git pull --ff-only
   git status   # must be clean
   ```

2. **Gate:**
   ```bash
   npm run release:check
   ```
   Runs `type-check`, `lint`, `format:check`, `test`, and asserts `CHANGELOG.md` has a populated `## Unreleased` section. Fix anything it flags before continuing.

3. **Promote the CHANGELOG.** Rename `## Unreleased` to `## X.Y.Z` and insert a fresh empty `## Unreleased` section above it. Stage the change:
   ```bash
   git add CHANGELOG.md
   git commit -m "promote CHANGELOG X.Y.Z"
   ```

4. **Bump the version and tag atomically:**
   ```bash
   npm version <patch|minor|major>
   ```
   This edits `package.json`, creates a commit titled `X.Y.Z`, and creates a `vX.Y.Z` tag pointing at that commit.

5. **Publish the tag:**
   ```bash
   git push --follow-tags
   ```

## Bump conventions

- **Patch** (`0.x.y` → `0.x.y+1`) — bug fixes, doc changes, no public API change.
- **Minor** (`0.x.y` → `0.x+1.0`) — new surface, deprecations, internal refactors that consumers won't feel.
- **Major** (`0.x.y` → `x+1.0.0`) — removals, signature changes, renames. In 0.x the minor is the de-facto major; we bumped 0.3.0 to remove the pre-0.2 monolith.

## Consumer upgrade path

Consumers pin by tag (`@laboverwire/stitch#v0.3.0`) or sha in their `package.json` git URL. There is no npm registry entry. `files` and `publishConfig` are intentionally absent.
