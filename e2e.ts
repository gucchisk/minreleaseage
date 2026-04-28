'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';

const CLI = path.join(__dirname, 'dist', 'cli.js');

function runCLI(cwd: string, minAgeHours: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, minAgeHours], { cwd, encoding: 'utf8' });
}

function runCLIWithDir(minAgeHours: string, dir: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, minAgeHours, '--dir', dir], { encoding: 'utf8' });
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

// ---------------------------------------------------------------------------
// --dir オプション
// ---------------------------------------------------------------------------

describe('--dir オプション (integration)', () => {
  it('--dir でnpmのtestdataディレクトリを指定できる', () => {
    const dir = path.join(__dirname, 'testdata', 'npm');
    const result = runCLIWithDir('0', dir);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('--dir で相対パスを指定できる', () => {
    const result = runCLIWithDir('0', './testdata/npm');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('--dir に値がない場合エラーになる', () => {
    const result = spawnSync(process.execPath, [CLI, '0', '--dir'], { encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('--dir requires a path argument'), `stderr: ${result.stderr}`);
  });

  it('--dir が重複している場合エラーになる', () => {
    const result = spawnSync(process.execPath, [CLI, '0', '--dir', './testdata/npm', '--dir', './testdata/npm'], { encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('--dir can only be specified once'), `stderr: ${result.stderr}`);
  });

  it('余分な引数がある場合エラーになる', () => {
    const result = spawnSync(process.execPath, [CLI, '0', 'extra'], { encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('unexpected argument'), `stderr: ${result.stderr}`);
  });

  it('未知のオプションがある場合エラーになる', () => {
    const result = spawnSync(process.execPath, [CLI, '0', '--unknown'], { encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('unexpected argument'), `stderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// pnpm (pnpm-lock.yaml v9)
// ---------------------------------------------------------------------------

describe('pnpm-lock.yaml (integration)', () => {
  const cwd = path.join(__dirname, 'testdata', 'pnpm');

  it('testdata/pnpm のパッケージが 0 時間以上前にリリースされている', () => {
    const result = runCLI(cwd, '0');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('All'), `stdout: ${result.stdout}`);
  });

  it('testdata/pnpm のパッケージが 999999 時間以上前にはリリースされていない', () => {
    const result = runCLI(cwd, '999999');
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes('FAIL:'), `stderr: ${result.stderr}`);
  });
});
