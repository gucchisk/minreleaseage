'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';

const CLI = path.join(__dirname, 'dist', 'cli.js');

function runCLI(cwd: string, minAgeHours: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, minAgeHours], { cwd, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// npm (package-lock.json)
// ---------------------------------------------------------------------------

describe('package-lock.json (integration)', () => {
  const cwd = path.join(__dirname, 'testdata', 'npm');

  it('testdata/npm のパッケージが 0 時間以上前にリリースされている', () => {
    const result = runCLI(cwd, '0');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('testdata/npm のパッケージが 999999 時間以上前にはリリースされていない', () => {
    const result = runCLI(cwd, '999999');
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('FAIL:'), `stderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Yarn Classic (yarn.lock v1)
// ---------------------------------------------------------------------------

describe('yarn.lock Classic (integration)', () => {
  const cwd = path.join(__dirname, 'testdata', 'yarn-classic');

  it('testdata/yarn-classic のパッケージが 0 時間以上前にリリースされている', () => {
    const result = runCLI(cwd, '0');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('testdata/yarn-classic のパッケージが 999999 時間以上前にはリリースされていない', () => {
    const result = runCLI(cwd, '999999');
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('FAIL:'), `stderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Yarn Berry (yarn.lock v2+)
// ---------------------------------------------------------------------------

describe('yarn.lock Berry (integration)', () => {
  const cwd = path.join(__dirname, 'testdata', 'yarn-berry');

  it('testdata/yarn-berry のパッケージが 0 時間以上前にリリースされている', () => {
    const result = runCLI(cwd, '0');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('testdata/yarn-berry のパッケージが 999999 時間以上前にはリリースされていない', () => {
    const result = runCLI(cwd, '999999');
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('FAIL:'), `stderr: ${result.stderr}`);
  });
});
