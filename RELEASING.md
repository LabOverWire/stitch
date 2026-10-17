# Releasing

`@laboverwire/stitch` is published to npm under the `@laboverwire` org and tagged on `main`. Consumers can install from the registry or pin a git tag/sha.

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

5. **Push the tag:**
   ```bash
   git push --follow-tags
   ```
   The push of `vX.Y.Z` triggers `.github/workflows/release.yml`, which:
   - Verifies the tag matches `package.json` `version`
   - Runs `npm run check` and `npm run build`
   - Runs `npm publish --access public --provenance`
   - Creates a GitHub Release whose body is the matching `## X.Y.Z` section of `CHANGELOG.md` (extracted via `scripts/extract-changelog.mjs`)

   Watch the run under [Actions](https://github.com/LabOverWire/stitch/actions). If it fails, fix the issue, push a new commit on `main`, delete the bad tag locally and on the remote, then redo the tag step.

### How publishing authenticates

The workflow publishes over **npm trusted publishing (OIDC)** — no `NPM_TOKEN` secret. The `id-token: write` permission lets the runner mint a short-lived OIDC token that npm exchanges for a scoped, one-shot publish credential, and provenance is attached automatically. npm trusts it because the package is configured with a trusted publisher (npmjs.com → the package → Settings → Trusted publishing) bound to this repo and the `release.yml` workflow, with the `npm publish` action allowed.

There is nothing to rotate. If the trust is ever lost (publisher connection deleted, or publishing from a different workflow), reconfigure it on npmjs.com rather than reintroducing a token. A newly created trusted-publisher connection must complete its first publish within 2 days or it expires.

### Local fallback

Publishing from a laptop still works but requires a 2FA one-time password, since OIDC only applies in CI:
```bash
npm login
git checkout vX.Y.Z
npm publish --access public --otp=<code>
git checkout main
```
`prepublishOnly` reruns `clean` + `check` + `build`, so the published tarball always contains a fresh `dist/` regardless of the working tree.

## Bump conventions

- **Patch** (`0.x.y` → `0.x.y+1`) — bug fixes, doc changes, no public API change.
- **Minor** (`0.x.y` → `0.x+1.0`) — new surface, deprecations, internal refactors that consumers won't feel.
- **Major** (`0.x.y` → `x+1.0.0`) — removals, signature changes, renames. In 0.x the minor is the de-facto major; we bumped 0.3.0 to remove the pre-0.2 monolith.

## Consumer upgrade path

Consumers install from npm (`npm install @laboverwire/stitch`) or pin a git tag (`@laboverwire/stitch#v0.3.0`) / sha in their `package.json` git URL. The npm tarball contains only `dist/`, `README.md`, `LICENSE`, and `CHANGELOG.md` (see the `files` allowlist in `package.json`).
