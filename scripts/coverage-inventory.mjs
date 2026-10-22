#!/usr/bin/env node
// Verifies that coverage accounts for every production TypeScript file under src/,
// including modules no test imports, and re-checks the 90% floor for all four metrics in total (a GLOBAL threshold, not per file).
// Run after `c8` has written coverage/coverage-summary.json. Prints repo-relative paths only.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const FLOOR = 90;
const METRICS = ['statements', 'branches', 'functions', 'lines'];

function productionSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

let summary;
try {
  summary = JSON.parse(readFileSync(join(root, 'coverage', 'coverage-summary.json'), 'utf8'));
} catch {
  console.error('coverage/coverage-summary.json is missing; run the c8 coverage command first.');
  process.exit(2);
}

const byRelativePath = new Map(
  Object.entries(summary).filter(([key]) => key !== 'total').map(([key, value]) => [relative(root, key).split(sep).join('/'), value]),
);
const sources = productionSources(join(root, 'src')).map((path) => relative(root, path).split(sep).join('/')).sort();
const failures = [];

console.log(`Production TypeScript inventory (${sources.length} files)`);
console.log('file'.padEnd(34) + METRICS.map((metric) => metric.padStart(12)).join(''));
for (const source of sources) {
  const entry = byRelativePath.get(source);
  if (!entry) {
    failures.push(`${source} is absent from the coverage report`);
    console.log(source.padEnd(34) + 'NOT REPORTED'.padStart(12));
    continue;
  }
  console.log(source.padEnd(34) + METRICS.map((metric) => `${entry[metric].pct}%`.padStart(12)).join(''));
}
for (const reported of byRelativePath.keys()) {
  if (!sources.includes(reported)) failures.push(`${reported} is reported but is not a production src/ file`);
}
console.log('TOTAL'.padEnd(34) + METRICS.map((metric) => `${summary.total[metric].pct}%`.padStart(12)).join(''));
for (const metric of METRICS) {
  const pct = summary.total[metric].pct;
  if (typeof pct !== 'number' || pct < FLOOR) failures.push(`total ${metric} ${pct}% is below ${FLOOR}%`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`Coverage inventory failure: ${failure}`);
  process.exit(1);
}
