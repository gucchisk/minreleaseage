'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'bin', 'minreleaseage.js');
const TESTDATA_DIR = path.join(__dirname, 'testdata', 'npm');

// ---------------------------------------------------------------------------
// checkPackageAges (integration)
// ---------------------------------------------------------------------------

describe('checkPackageAges (integration)', () => {
  it('testdata/npm/package-lock.json のパッケージが 0 時間以上前にリリースされている', () => {
    const result = spawnSync(process.execPath, [CLI, '0'], {
      cwd: TESTDATA_DIR,
      encoding: 'utf8',
    });

    assert.equal(
      result.status,
      0,
      `終了コードが 0 であること。stderr: ${result.stderr}`
    );
    assert.ok(
      result.stdout.includes('All'),
      `stdout に "All" が含まれること。stdout: ${result.stdout}`
    );
  });

  it('testdata/npm/package-lock.json のパッケージが 999999 時間以上前にはリリースされていない', () => {
    const result = spawnSync(process.execPath, [CLI, '999999'], {
      cwd: TESTDATA_DIR,
      encoding: 'utf8',
    });

    assert.equal(
      result.status,
      1,
      `終了コードが 1 であること。stdout: ${result.stdout}`
    );
    assert.ok(
      result.stderr.includes('FAIL:'),
      `stderr に "FAIL:" が含まれること。stderr: ${result.stderr}`
    );
  });
});
