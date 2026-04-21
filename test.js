'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('https');
const { EventEmitter } = require('events');

const { readPackageLock, fetchReleaseDate } = require('./index.js');

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/**
 * テスト用の HTTPS レスポンスモックを生成する
 * @param {number} statusCode
 * @param {object} bodyObject
 */
function createMockResponse(statusCode, bodyObject) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  setImmediate(() => {
    response.emit('data', JSON.stringify(bodyObject));
    response.emit('end');
  });
  return response;
}

/**
 * テスト用の一時 package-lock.json を作成して、そのパスと一時ディレクトリを返す
 * @param {object} lockfileContent
 * @returns {{ filePath: string, tmpDir: string }}
 */
function writeTempLockfile(lockfileContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minreleaseage-test-'));
  const filePath = path.join(tmpDir, 'package-lock.json');
  fs.writeFileSync(filePath, JSON.stringify(lockfileContent), 'utf8');
  return { filePath, tmpDir };
}

/**
 * 一時ディレクトリを削除する
 * @param {string} tmpDir
 */
function removeTempDir(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// readPackageLock
// ---------------------------------------------------------------------------

describe('readPackageLock', () => {
  it('存在しないファイルを指定した場合はエラーをスローする', () => {
    assert.throws(
      () => readPackageLock('/nonexistent/package-lock.json'),
      /package-lock.json not found at:/
    );
  });

  it('lockfileVersion 3 の packages フィールドからパッケージ一覧を返す', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/foo': { version: '1.0.0' },
        'node_modules/bar': { version: '2.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 2);
      assert.deepEqual(packages.find((p) => p.name === 'foo'), { name: 'foo', version: '1.0.0' });
      assert.deepEqual(packages.find((p) => p.name === 'bar'), { name: 'bar', version: '2.0.0' });
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('ルートパッケージ（空文字キー）をスキップする', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        '': { name: 'myapp', version: '1.0.0' },
        'node_modules/dep': { version: '3.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'dep');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('symlink エントリをスキップする', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        'node_modules/real-pkg': { version: '1.0.0' },
        'node_modules/symlinked-pkg': { version: '1.0.0', link: true },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'real-pkg');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('version フィールドのないエントリをスキップする', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        'node_modules/with-version': { version: '1.0.0' },
        'node_modules/without-version': {},
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'with-version');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('同名・同バージョンの重複エントリを 1 つにまとめる', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        'node_modules/foo': { version: '1.0.0' },
        'node_modules/bar/node_modules/foo': { version: '1.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'foo');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('スコープ付きパッケージ名（@scope/pkg）を正しく取得する', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        'node_modules/@scope/pkg': { version: '1.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, '@scope/pkg');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('pkgInfo.name が存在する場合はそれをパッケージ名として使用する', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 2,
      packages: {
        'node_modules/path-alias': { name: 'actual-name', version: '1.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'actual-name');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('lockfileVersion 1 の dependencies フィールドからパッケージ一覧を返す', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 1,
      dependencies: {
        foo: { version: '1.0.0' },
        bar: { version: '2.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 2);
      assert.ok(packages.some((p) => p.name === 'foo' && p.version === '1.0.0'));
      assert.ok(packages.some((p) => p.name === 'bar' && p.version === '2.0.0'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('lockfileVersion 1 のネストした依存関係を再帰的に収集する', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 1,
      dependencies: {
        foo: {
          version: '1.0.0',
          dependencies: {
            bar: {
              version: '2.0.0',
              dependencies: {
                baz: { version: '3.0.0' },
              },
            },
          },
        },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 3);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('lockfileVersion 1 で同名・同バージョンの重複エントリを 1 つにまとめる', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 1,
      dependencies: {
        foo: {
          version: '1.0.0',
          dependencies: {
            foo: { version: '1.0.0' }, // 同一バージョンの重複
          },
        },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('testdata/npm の package-lock.json を正しく読み込む（axios を含む）', () => {
    const lockfilePath = path.join(__dirname, 'testdata', 'npm', 'package-lock.json');
    const packages = readPackageLock(lockfilePath);
    assert.ok(packages.length > 0);
    const axios = packages.find((p) => p.name === 'axios');
    assert.ok(axios, 'axios が含まれていること');
    assert.equal(axios.version, '1.15.1');
  });
});

// ---------------------------------------------------------------------------
// fetchReleaseDate
// ---------------------------------------------------------------------------

describe('fetchReleaseDate', () => {
  it('成功時に Date オブジェクトを返す', async (t) => {
    const releaseDate = '2024-01-15T10:00:00.000Z';
    t.mock.method(https, 'get', (_url, _options, callback) => {
      callback(createMockResponse(200, { time: { '1.0.0': releaseDate } }));
      return new EventEmitter();
    });

    const result = await fetchReleaseDate('some-package', '1.0.0');
    assert.ok(result instanceof Date);
    assert.equal(result.toISOString(), releaseDate);
  });

  it('スコープ付きパッケージの "/" を "%2F" にエンコードしてリクエストする', async (t) => {
    let capturedUrl = '';
    t.mock.method(https, 'get', (url, _options, callback) => {
      capturedUrl = url;
      callback(createMockResponse(200, { time: { '1.0.0': '2024-01-01T00:00:00.000Z' } }));
      return new EventEmitter();
    });

    await fetchReleaseDate('@scope/package', '1.0.0');
    assert.ok(
      capturedUrl.includes('%2F'),
      `URL が "/" を "%2F" にエンコードすること。実際の URL: ${capturedUrl}`
    );
    assert.ok(
      !capturedUrl.includes('@scope/package'),
      'URL にエンコードされていない "/" が含まれないこと'
    );
  });

  it('404 レスポンスの場合はパッケージ未発見エラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url, _options, callback) => {
      callback(createMockResponse(404, {}));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('unknown-package', '1.0.0'),
      /Package not found on npm registry: unknown-package@1\.0\.0/
    );
  });

  it('200 以外のレスポンスの場合はステータスコードを含むエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url, _options, callback) => {
      callback(createMockResponse(503, {}));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /npm registry returned status 503 for some-package/
    );
  });

  it('time フィールドに指定バージョンがない場合はエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url, _options, callback) => {
      // 別バージョンのみ存在する
      callback(createMockResponse(200, { time: { '2.0.0': '2024-01-01T00:00:00.000Z' } }));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Release time not found for some-package@1\.0\.0/
    );
  });

  it('time フィールド自体がない場合はエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url, _options, callback) => {
      callback(createMockResponse(200, { name: 'some-package' })); // time なし
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Release time not found for some-package@1\.0\.0/
    );
  });

  it('不正な JSON レスポンスの場合はパースエラーを返す', async (t) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    t.mock.method(https, 'get', (_url, _options, callback) => {
      setImmediate(() => {
        response.emit('data', 'invalid json {{{');
        response.emit('end');
      });
      callback(response);
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Failed to parse registry response for some-package/
    );
  });

  it('ネットワークエラーの場合はネットワークエラーを返す', async (t) => {
    const mockRequest = new EventEmitter();
    t.mock.method(https, 'get', () => {
      setImmediate(() => {
        mockRequest.emit('error', new Error('ECONNREFUSED'));
      });
      return mockRequest;
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Network error fetching some-package: ECONNREFUSED/
    );
  });
});

