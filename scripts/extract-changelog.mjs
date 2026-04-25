#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('usage: extract-changelog.mjs <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
  console.error(`extract-changelog.mjs: "${version}" is not a valid SemVer version.`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, '..', 'CHANGELOG.md');
const text = readFileSync(changelogPath, 'utf8');
const lines = text.split('\n');

const heading = `## ${version}`;
const startIdx = lines.findIndex(
  (l) => l === heading || l.startsWith(`${heading} `) || l.startsWith(`${heading}\t`)
);
if (startIdx === -1) {
  console.error(`CHANGELOG.md: no "## ${version}" section found.`);
  process.exit(1);
}

const endIdx = lines.findIndex((l, i) => i > startIdx && /^##\s+/.test(l));
const body = lines
  .slice(startIdx + 1, endIdx === -1 ? undefined : endIdx)
  .join('\n')
  .trim();

if (!body) {
  console.error(`CHANGELOG.md: "## ${version}" section is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
