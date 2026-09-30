import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const dbPath = join(tmpdir(), `satpass-cli-${process.pid}-${Date.now()}.sqlite`);

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [cli, '--db', dbPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

after(() => rmSync(dbPath, { force: true }));

test('CLI scenario/orbit/station/pass/export lifecycle with before/after state', () => {
  assert.match(run(['scenario-create', '--name', 'X']).stdout, /\[before\][\s\S]*\[after \]/);
  const orbit = run([
    'orbit-create', '--scenario', '1', '--a', '7200000', '--e', '0.001',
    '--i', '80', '--raan', '10', '--argp', '0', '--M0', '0', '--epoch', '1700000000',
  ]);
  assert.equal(orbit.status, 0);
  assert.match(orbit.stdout, /orbit #1 created/);
  const station = run([
    'station-create', '--scenario', '1', '--name', 'S',
    '--lat', '30', '--lon', '120', '--alt', '0', '--el', '10',
  ]);
  assert.equal(station.status, 0);

  const passes = run([
    'passes', '--orbit', '1', '--station', '1',
    '--from', '1700000000', '--to', '1700086400', '--step', '30',
    '--save', '--rid', 'k1',
  ]);
  assert.equal(passes.status, 0);
  assert.match(passes.stdout, /AOS=/);

  // idempotent repeat -> same report, created=false
  const again = run([
    'passes', '--orbit', '1', '--station', '1',
    '--from', '1700000000', '--to', '1700086400', '--step', '30',
    '--save', '--rid', 'k1',
  ]);
  assert.match(again.stdout, /created=false/);
});

test('CLI rejects unsupported orbit with non-zero exit and error code', () => {
  const r = run([
    'orbit-create', '--scenario', '1', '--a', '6500000', '--e', '0.2',
    '--i', '10', '--epoch', '1',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UNSUPPORTED_ORBIT/);
});

test('CLI help lists commands', () => {
  assert.match(run(['help']).stdout, /compare-gates/);
});
