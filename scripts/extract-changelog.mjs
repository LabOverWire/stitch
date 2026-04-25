#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('usage: extract-changelog.mjs <version>');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, '..', 'CHANGELOG.md');
const text = readFileSync(changelogPath, 'utf8');
const lines = text.split('\n');

const headingPattern = new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
const startIdx = lines.findIndex((l) => headingPattern.test(l));
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
