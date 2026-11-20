import assert from 'node:assert/strict';
import { accessSync, constants, copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'gta6-verify-'));
const kit = join(homedir(), 'workspace/makefun/gta6-trophy-rarity-forecast-01-kit/input');
const clamp = n => Math.max(0.01, Math.min(99.99, n));

function validate(bytes) {
  assert(bytes.length <= 65_536, 'Output size');
  const doc = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(doc), ['trophies']);
  assert.equal(doc.trophies.length, 55);
  assert.deepEqual(doc.trophies.map(t => t.id).sort((a, b) => a - b), Array.from({ length: 55 }, (_, i) => i + 1));
  for (const t of doc.trophies) {
    assert.deepEqual(Object.keys(t).sort(), ['id', 'q']);
    assert(Array.isArray(t.q) && t.q.length === 5);
    t.q.forEach((q, i) => {
      assert(typeof q === 'number' && Number.isFinite(q) && q >= 0 && q <= 100);
      if (i) assert(q >= t.q[i - 1], 'Quantile ordering');
    });
  }
  return doc;
}

async function doubleRun(input, label) {
  const outputs = [join(scratch, `${label}-a`), join(scratch, `${label}-b`)];
  for (const output of outputs) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [join(root, 'main.ts')], {
      env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output },
      encoding: 'utf8', timeout: 8000,
    });
    if (result.error?.code === 'EPERM' || result.error?.code === 'EACCES') {
      console.log(`${label}: subprocess denied; executing fresh module instance in this process`);
      const oldInput = process.env.MAKEFUN_INPUT_DIR;
      const oldOutput = process.env.MAKEFUN_OUTPUT_DIR;
      try {
        process.env.MAKEFUN_INPUT_DIR = input;
        process.env.MAKEFUN_OUTPUT_DIR = output;
        const entry = new URL('./main.ts', import.meta.url);
        entry.searchParams.set('verification', `${label}-${outputs.indexOf(output)}`);
        await import(entry.href);
      } finally {
        if (oldInput === undefined) delete process.env.MAKEFUN_INPUT_DIR;
        else process.env.MAKEFUN_INPUT_DIR = oldInput;
        if (oldOutput === undefined) delete process.env.MAKEFUN_OUTPUT_DIR;
        else process.env.MAKEFUN_OUTPUT_DIR = oldOutput;
      }
    } else {
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    console.log(`${label}: run ${(performance.now() - start).toFixed(1)} ms`);
  }
  const cases = readdirSync(input).filter(n => n.endsWith('.in')).sort().map(n => JSON.parse(readFileSync(join(input, n), 'utf8')));
  assert(cases.length > 0, 'No input cases');
  const expected = cases.map(c => `${c.id}.out`).sort();
  for (const output of outputs) assert.deepEqual(readdirSync(output).sort(), expected);
  const documents = new Map();
  for (const c of cases) {
    const name = `${c.id}.out`;
    const a = readFileSync(join(outputs[0], name));
    const b = readFileSync(join(outputs[1], name));
    assert(a.equals(b), `${name}: byte determinism`);
    const doc = validate(a);
    documents.set(c.id, doc);
    const differences = doc.trophies.map(t => {
      const i = c.trophies.findIndex(v => v.id === t.id);
      return Math.abs(t.q[2] - clamp(c.history.at(-1).rates[i] ?? 0));
    });
    console.log(`${name}: 55 rows, ${a.length} bytes, identical; median vs persistence mean |difference|=${(differences.reduce((s, v) => s + v, 0) / 55).toFixed(6)} pp, max=${Math.max(...differences).toFixed(6)} pp`);
    console.log(`  first medians: ${doc.trophies.slice(0, 5).map(t => t.q[2]).join(', ')}`);
  }
  return documents;
}

try {
  let available = false;
  try {
    accessSync(kit, constants.R_OK);
    for (const name of readdirSync(kit).filter(n => n.endsWith('.in'))) accessSync(join(kit, name), constants.R_OK);
    available = true;
  } catch (error) {
    console.log(`Practice input unavailable (${error.code}); using fixture for determinism.`);
  }
  if (available) await doubleRun(kit, 'practice');
  const fixtureInput = join(scratch, 'fixture-input');
  mkdirSync(fixtureInput);
  // Copy a checked-in fixture; this verifier does not generate source files.
  copyFileSync(join(root, 'dev-fixture.in'), join(fixtureInput, 'dev-fixture.in'));
  const fixture = JSON.parse(readFileSync(join(root, 'dev-fixture.in'), 'utf8'));
  for (const r of fixture.history) assert.equal(r.rates.length, 55);
  const doc = (await doubleRun(fixtureInput, 'fixture')).get('dev-fixture');
  const row = id => doc.trophies.find(t => t.id === id);
  const lastRate = fixture.history.at(-1).rates[0];
  assert(fixture.history.at(-1).players_tracked > fixture.history[0].players_tracked);
  const firstE = fixture.history[0].rates[0] * fixture.history[0].players_tracked / 100;
  const lastE = lastRate * fixture.history.at(-1).players_tracked / 100;
  assert(lastE > firstE, 'Earners increase while rates dilute');
  assert(row(1).q[2] > 0 && row(1).q[2] < lastRate, 'Forecast continues dilution');
  assert.equal(row(53).q[2], 0.02, 'Zero-earner handling');
  assert.equal(row(54).q[2], 99.99, 'Always-100 handling');
  assert.equal(row(55).q[2], 3.5, 'Sparse observation forward-fill fallback');
  console.log(`Dilution: P 1000→8000, E ${firstE}→${lastE}, last rate ${lastRate}%, forecast ${row(1).q[2]}%.`);
  console.log('PASS: schema, byte determinism, dilution direction and edge cases.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
