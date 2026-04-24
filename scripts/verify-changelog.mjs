#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, '..', 'CHANGELOG.md');
const text = readFileSync(changelogPath, 'utf8');

const lines = text.split('\n');
const unreleasedIdx = lines.findIndex((l) => /^##\s+Unreleased\b/i.test(l));
if (unreleasedIdx === -1) {
  console.error('CHANGELOG.md: no "## Unreleased" section found.');
  process.exit(1);
}

const nextSectionIdx = lines.findIndex(
  (l, i) => i > unreleasedIdx && /^##\s+/.test(l)
);
const body = lines.slice(unreleasedIdx + 1, nextSectionIdx === -1 ? undefined : nextSectionIdx);
const hasContent = body.some((l) => /^###\s+/.test(l)) && body.some((l) => l.trim().startsWith('-'));

if (!hasContent) {
  console.error(
    'CHANGELOG.md: "## Unreleased" is empty. Add at least one "### Added/Changed/Fixed/Removed" subsection with a bullet before cutting a release.'
  );
  process.exit(1);
}

console.log('CHANGELOG.md: Unreleased section is populated.');
