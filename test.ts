'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import https = require('https');
import { EventEmitter } from 'events';

import { readPackageLock, readYarnLock, readPnpmLock, fetchReleaseDate, validateRegistryUrl } from './src/index';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

interface MockResponse extends EventEmitter {
  statusCode: number;
}

function createMockResponse(statusCode: number, bodyObject: object): MockResponse {
  const response = new EventEmitter() as MockResponse;
  response.statusCode = statusCode;
  setImmediate(() => {
    response.emit('data', JSON.stringify(bodyObject));
    response.emit('end');
  });
  return response;
}

function writeTempLockfile(lockfileContent: object): { filePath: string; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minreleaseage-test-'));
  const filePath = path.join(tmpDir, 'package-lock.json');
  fs.writeFileSync(filePath, JSON.stringify(lockfileContent), 'utf8');
  return { filePath, tmpDir };
}

function writeTempFile(filename: string, content: string): { filePath: string; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minreleaseage-test-'));
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, tmpDir };
}

function removeTempDir(tmpDir: string): void {
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
            foo: { version: '1.0.0' },
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
    assert.equal(axios?.version, '1.15.2');
  });
});

// ---------------------------------------------------------------------------
// fetchReleaseDate
// ---------------------------------------------------------------------------

describe('fetchReleaseDate', () => {
  it('成功時に Date オブジェクトを返す', async (t) => {
    const releaseDate = '2024-01-15T10:00:00.000Z';
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
      callback(createMockResponse(200, { time: { '1.0.0': releaseDate } }));
      return new EventEmitter();
    });

    const result = await fetchReleaseDate('some-package', '1.0.0');
    assert.ok(result instanceof Date);
    assert.equal(result.toISOString(), releaseDate);
  });

  it('スコープ付きパッケージの "/" を "%2F" にエンコードしてリクエストする', async (t) => {
    let capturedUrl = '';
    t.mock.method(https, 'get', (url: string, _options: object, callback: (res: MockResponse) => void) => {
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
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
      callback(createMockResponse(404, {}));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('unknown-package', '1.0.0'),
      /Package not found on registry https:\/\/registry\.npmjs\.org: unknown-package@1\.0\.0/
    );
  });

  it('200 以外のレスポンスの場合はステータスコードを含むエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
      callback(createMockResponse(503, {}));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Registry https:\/\/registry\.npmjs\.org returned status 503 for some-package/
    );
  });

  it('time フィールドに指定バージョンがない場合はエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
      callback(createMockResponse(200, { time: { '2.0.0': '2024-01-01T00:00:00.000Z' } }));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Release time not found for some-package@1\.0\.0/
    );
  });

  it('time フィールド自体がない場合はエラーを返す', async (t) => {
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
      callback(createMockResponse(200, { name: 'some-package' }));
      return new EventEmitter();
    });

    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0'),
      /Release time not found for some-package@1\.0\.0/
    );
  });

  it('不正な JSON レスポンスの場合はパースエラーを返す', async (t) => {
    const response = new EventEmitter() as MockResponse;
    response.statusCode = 200;
    t.mock.method(https, 'get', (_url: string, _options: object, callback: (res: MockResponse) => void) => {
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

  it('http:// のレジストリURLを指定した場合はエラーを返す', async () => {
    await assert.rejects(
      () => fetchReleaseDate('some-package', '1.0.0', 'http://insecure-registry.example.com'),
      /Registry URL must use HTTPS: http:\/\/insecure-registry\.example\.com/
    );
  });
});

// ---------------------------------------------------------------------------
// readYarnLock
// ---------------------------------------------------------------------------

describe('readYarnLock', () => {
  it('存在しないファイルを指定した場合はエラーをスローする', () => {
    assert.throws(
      () => readYarnLock('/nonexistent/yarn.lock'),
      /yarn.lock not found at:/
    );
  });

  // --- Yarn Classic ---

  it('[Classic] 基本的なパッケージを読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '# yarn lockfile v1',
      '',
      'ms@^2.1.1:',
      '  version "2.1.3"',
      '  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'ms');
      assert.equal(packages[0].version, '2.1.3');
      assert.equal(packages[0].registryUrl, 'https://registry.yarnpkg.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Classic] スコープ付きパッケージを読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '# yarn lockfile v1',
      '',
      '"@scope/pkg@^1.0.0":',
      '  version "1.2.3"',
      '  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3.tgz"',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, '@scope/pkg');
      assert.equal(packages[0].version, '1.2.3');
      assert.equal(packages[0].registryUrl, 'https://registry.yarnpkg.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Classic] 同一descriptor行に複数のrangeが並ぶ場合に1エントリにまとめる', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '# yarn lockfile v1',
      '',
      'ms@^2.0.0, ms@^2.1.0, ms@^2.1.1:',
      '  version "2.1.3"',
      '  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'ms');
      assert.equal(packages[0].version, '2.1.3');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Classic] 同名・同バージョンの重複エントリを1つにまとめる', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '# yarn lockfile v1',
      '',
      'ms@^2.1.0:',
      '  version "2.1.3"',
      '',
      'ms@^2.1.1:',
      '  version "2.1.3"',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Classic] 複数の異なるパッケージをすべて読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '# yarn lockfile v1',
      '',
      'ms@^2.1.1:',
      '  version "2.1.3"',
      '',
      'debug@^4.0.0:',
      '  version "4.3.4"',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 2);
      assert.ok(packages.some((p) => p.name === 'ms' && p.version === '2.1.3'));
      assert.ok(packages.some((p) => p.name === 'debug' && p.version === '4.3.4'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  // --- Yarn Berry ---

  it('[Berry] linkType: hard のパッケージを読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.deepEqual(packages[0], { name: 'ms', version: '2.1.3' });
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Berry] linkType: soft のパッケージ（workspace等）をスキップする', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"my-app@workspace:.":',
      '  version: 0.0.0-use.local',
      '  resolution: "my-app@workspace:."',
      '  languageName: unknown',
      '  linkType: soft',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'ms');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Berry] __metadata ブロックをスキップする', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '  cacheKey: 8',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'ms');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Berry] スコープ付きパッケージを読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"@scope/pkg@npm:^1.0.0":',
      '  version: 1.2.3',
      '  resolution: "@scope/pkg@npm:1.2.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.deepEqual(packages[0], { name: '@scope/pkg', version: '1.2.3' });
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Berry] 同名・同バージョンの重複エントリを1つにまとめる', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"ms@npm:^2.1.0":',
      '  version: 2.1.3',
      '  languageName: node',
      '  linkType: hard',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Classic] CRLF改行でも正しく読み込む', () => {
    const lines = [
      '# yarn lockfile v1',
      '',
      'ms@^2.1.1:',
      '  version "2.1.3"',
      '  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"',
    ];
    const { filePath, tmpDir } = writeTempFile('yarn.lock', lines.join('\r\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1, 'CRLFでもパッケージが0件にならないこと');
      assert.equal(packages[0].name, 'ms');
      assert.equal(packages[0].version, '2.1.3');
      assert.equal(packages[0].registryUrl, 'https://registry.yarnpkg.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('[Berry] CRLF改行でも正しく読み込む', () => {
    const lines = [
      '__metadata:',
      '  version: 6',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ];
    const { filePath, tmpDir } = writeTempFile('yarn.lock', lines.join('\r\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1, 'CRLFでもパッケージが0件にならないこと');
      assert.deepEqual(packages[0], { name: 'ms', version: '2.1.3' });
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('testdata/yarn-classic/yarn.lock を正しく読み込む', () => {
    const lockfilePath = path.join(__dirname, 'testdata', 'yarn-classic', 'yarn.lock');
    const packages = readYarnLock(lockfilePath);
    assert.ok(packages.length > 0);
    const axios = packages.find((p) => p.name === 'axios');
    assert.ok(axios, 'axios が含まれていること');
    assert.equal(axios?.version, '1.15.2');
  });

  it('testdata/yarn-berry/yarn.lock を正しく読み込む', () => {
    const lockfilePath = path.join(__dirname, 'testdata', 'yarn-berry', 'yarn.lock');
    const packages = readYarnLock(lockfilePath);
    assert.ok(packages.length > 0);
    const axios = packages.find((p) => p.name === 'axios');
    assert.ok(axios, 'axios が含まれていること');
    assert.equal(axios?.version, '1.15.2');
  });

});

// ---------------------------------------------------------------------------
// readPnpmLock
// ---------------------------------------------------------------------------

const V9_LINES = [
  "lockfileVersion: '9.0'",
  '',
  'packages:',
  '',
  '  lodash@4.17.21:',
  '    resolution: {integrity: sha512-abc}',
  '',
  "  '@scope/pkg@1.0.0':",
  '    resolution: {integrity: sha512-def}',
  '',
  'snapshots:',
  '',
  '  lodash@4.17.21: {}',
];

describe('readPnpmLock', () => {
  it('存在しないファイルを指定した場合はエラーをスローする', () => {
    assert.throws(
      () => readPnpmLock('/nonexistent/pnpm-lock.yaml'),
      /pnpm-lock.yaml not found at:/
    );
  });

  it('v9形式（LF）からパッケージを読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', V9_LINES.join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 2);
      assert.ok(packages.some((p) => p.name === 'lodash' && p.version === '4.17.21'));
      assert.ok(packages.some((p) => p.name === '@scope/pkg' && p.version === '1.0.0'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('v9形式（CRLF）でも正しく読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', V9_LINES.join('\r\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 2, 'CRLFでもパッケージが0件にならないこと');
      assert.ok(packages.some((p) => p.name === 'lodash' && p.version === '4.17.21'));
      assert.ok(packages.some((p) => p.name === '@scope/pkg' && p.version === '1.0.0'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('v6形式（/name@version）を読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', [
      "lockfileVersion: '6.0'",
      '',
      'packages:',
      '',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-abc}',
      '',
      '  /@scope/pkg@1.0.0:',
      '    resolution: {integrity: sha512-def}',
    ].join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 2);
      assert.ok(packages.some((p) => p.name === 'lodash' && p.version === '4.17.21'));
      assert.ok(packages.some((p) => p.name === '@scope/pkg' && p.version === '1.0.0'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('v5形式（/name/version）を読み込む', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', [
      'lockfileVersion: 5.4',
      '',
      'packages:',
      '',
      '  /lodash/4.17.21:',
      '    resolution: {integrity: sha512-abc}',
      '',
      '  /@scope/pkg/1.0.0:',
      '    resolution: {integrity: sha512-def}',
    ].join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 2);
      assert.ok(packages.some((p) => p.name === 'lodash' && p.version === '4.17.21'));
      assert.ok(packages.some((p) => p.name === '@scope/pkg' && p.version === '1.0.0'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('ピア依存サフィックス（アンダースコア形式）を除去する', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', [
      "lockfileVersion: '6.0'",
      '',
      'packages:',
      '',
      '  /react@18.2.0_react-dom@18.2.0:',
      '    resolution: {integrity: sha512-abc}',
    ].join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'react');
      assert.equal(packages[0].version, '18.2.0');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('ピア依存サフィックス（括弧形式）を除去する', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      '  react@18.2.0(react-dom@18.2.0):',
      '    resolution: {integrity: sha512-abc}',
    ].join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'react');
      assert.equal(packages[0].version, '18.2.0');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('snapshots: セクションのエントリは無視する', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', V9_LINES.join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.equal(packages.length, 2);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('testdata/pnpm/pnpm-lock.yaml を正しく読み込む（axios を含む）', () => {
    const lockfilePath = path.join(__dirname, 'testdata', 'pnpm', 'pnpm-lock.yaml');
    const packages = readPnpmLock(lockfilePath);
    assert.ok(packages.length > 0);
    const axios = packages.find((p) => p.name === 'axios');
    assert.ok(axios, 'axios が含まれていること');
    assert.equal(axios?.version, '1.15.2');
  });

  it('.npmrc に registry が設定されている場合、registryUrl を付与する', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', V9_LINES.join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.npmrc'), 'registry=https://my-registry.example.com/\n', 'utf8');
    try {
      const packages = readPnpmLock(filePath);
      assert.ok(packages.length > 0);
      assert.ok(packages.every((p) => p.registryUrl === 'https://my-registry.example.com'));
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('.npmrc がない場合、registryUrl を付与しない', () => {
    const { filePath, tmpDir } = writeTempFile('pnpm-lock.yaml', V9_LINES.join('\n'));
    try {
      const packages = readPnpmLock(filePath);
      assert.ok(packages.length > 0);
      assert.ok(packages.every((p) => p.registryUrl === undefined));
    } finally {
      removeTempDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// レジストリURL取得（yarn berry + .yarnrc.yml）
// ---------------------------------------------------------------------------

describe('readYarnLock berry レジストリ設定', () => {
  it('.yarnrc.yml に npmRegistryServer が設定されている場合、registryUrl を付与する', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    fs.writeFileSync(
      path.join(tmpDir, '.yarnrc.yml'),
      'npmRegistryServer: "https://my-registry.example.com"\n',
      'utf8'
    );
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].name, 'ms');
      assert.equal(packages[0].registryUrl, 'https://my-registry.example.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('.yarnrc.yml がない場合、registryUrl を付与しない', () => {
    const { filePath, tmpDir } = writeTempFile('yarn.lock', [
      '__metadata:',
      '  version: 6',
      '',
      '"ms@npm:^2.1.1":',
      '  version: 2.1.3',
      '  resolution: "ms@npm:2.1.3"',
      '  languageName: node',
      '  linkType: hard',
    ].join('\n'));
    try {
      const packages = readYarnLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].registryUrl, undefined);
    } finally {
      removeTempDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// レジストリURL取得（npm package-lock.json の resolved フィールド）
// ---------------------------------------------------------------------------

describe('readPackageLock レジストリ設定', () => {
  it('resolved フィールドからレジストリURLを取得する', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/foo': {
          version: '1.0.0',
          resolved: 'https://my-registry.example.com/foo/-/foo-1.0.0.tgz',
        },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].registryUrl, 'https://my-registry.example.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('resolved フィールドがない場合、registryUrl を付与しない', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/foo': { version: '1.0.0' },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].registryUrl, undefined);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it('スコープ付きパッケージの resolved URL で "/" がエンコードされていてもレジストリURLを取得できる', () => {
    const { filePath, tmpDir } = writeTempLockfile({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/@scope/pkg': {
          version: '1.0.0',
          resolved: 'https://my-registry.example.com/@scope%2Fpkg/-/pkg-1.0.0.tgz',
        },
      },
    });
    try {
      const packages = readPackageLock(filePath);
      assert.equal(packages.length, 1);
      assert.equal(packages[0].registryUrl, 'https://my-registry.example.com');
    } finally {
      removeTempDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// validateRegistryUrl
// ---------------------------------------------------------------------------

describe('validateRegistryUrl', () => {
  // --- エラーになるべきケース ---

  it('http:// はエラー', () => {
    assert.throws(() => validateRegistryUrl('http://registry.npmjs.org'), /Registry URL must use HTTPS/);
  });

  it('ftp:// はエラー', () => {
    assert.throws(() => validateRegistryUrl('ftp://registry.npmjs.org'), /Registry URL must use HTTPS/);
  });

  it('パース不可能なURLはエラー', () => {
    assert.throws(() => validateRegistryUrl('not-a-url'), /Invalid registry URL/);
  });

  it('IPv4アドレス指定はエラー', () => {
    assert.throws(() => validateRegistryUrl('https://127.0.0.1'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  it('IPv4プライベートアドレスはエラー', () => {
    assert.throws(() => validateRegistryUrl('https://192.168.0.1'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  it('IPv4リンクローカル（AWS IMDS）はエラー', () => {
    assert.throws(() => validateRegistryUrl('https://169.254.169.254'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  it('パブリックIPv4もエラー', () => {
    assert.throws(() => validateRegistryUrl('https://8.8.8.8'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  it('IPv6アドレス指定はエラー', () => {
    assert.throws(() => validateRegistryUrl('https://[::1]'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  it('パブリックIPv6もエラー', () => {
    assert.throws(() => validateRegistryUrl('https://[2001:db8::1]'), /Blocked registry URL \(IP address is not allowed\)/);
  });

  // --- 通過すべきケース ---

  it('https://registry.npmjs.org は通過', () => {
    assert.doesNotThrow(() => validateRegistryUrl('https://registry.npmjs.org'));
  });

  it('https://registry.yarnpkg.com は通過', () => {
    assert.doesNotThrow(() => validateRegistryUrl('https://registry.yarnpkg.com'));
  });

  it('カスタムドメインは通過', () => {
    assert.doesNotThrow(() => validateRegistryUrl('https://my-registry.example.com'));
  });

  it('パス付きカスタムレジストリは通過', () => {
    assert.doesNotThrow(() => validateRegistryUrl('https://my-registry.example.com/path/to/npm'));
  });
});

