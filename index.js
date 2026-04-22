'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * npm registryからパッケージのリリース日時を取得する
 * パッケージルートエンドポイント(GET /packageName)の time[version] を使用する
 * @param {string} packageName
 * @param {string} version
 * @returns {Promise<Date>}
 */
function fetchReleaseDate(packageName, version) {
  return new Promise((resolve, reject) => {
    // スコープ付きパッケージ (@scope/name) は / を %2F にエンコードする
    const encodedName = packageName.startsWith('@')
      ? packageName.replace('/', '%2F')
      : packageName;
    const url = `https://registry.npmjs.org/${encodedName}`;

    const options = {
      headers: {
        // time フィールドを含む完全なpackumentを要求する
        Accept: 'application/json',
      },
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 404) {
        reject(new Error(`Package not found on npm registry: ${packageName}@${version}`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`npm registry returned status ${res.statusCode} for ${packageName}`));
        return;
      }

      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          // パッケージルートレスポンスの time オブジェクトからバージョンの公開日時を取得する
          const releaseTime = data.time && data.time[version];
          if (releaseTime) {
            resolve(new Date(releaseTime));
          } else {
            reject(new Error(`Release time not found for ${packageName}@${version}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse registry response for ${packageName}: ${e.message}`));
        }
      });
    }).on('error', (err) => {
      reject(new Error(`Network error fetching ${packageName}: ${err.message}`));
    });
  });
}

/**
 * package-lock.jsonを読み込んでパッケージ一覧を返す
 * @param {string} lockfilePath
 * @returns {{ name: string, version: string }[]}
 */
function readPackageLock(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`package-lock.json not found at: ${lockfilePath}`);
  }

  const content = fs.readFileSync(lockfilePath, 'utf8');
  const lockData = JSON.parse(content);

  const packages = new Map();

  // lockfileVersion 2以上は packages フィールドを使用
  if (lockData.packages) {
    for (const [pkgPath, pkgInfo] of Object.entries(lockData.packages)) {
      // ルートパッケージ(空文字キー)はスキップ
      if (pkgPath === '') continue;
      // symlink はスキップ
      if (pkgInfo.link) continue;

      const version = pkgInfo.version;
      if (!version) continue;

      // pkgInfo.name があればそれを使用、なければパスの最後の node_modules/ 以降を取得
      // 例: "node_modules/foo/node_modules/bar" → "bar"
      //     "node_modules/@scope/pkg" → "@scope/pkg"
      const name = pkgInfo.name || pkgPath.replace(/^.*node_modules\//, '');

      if (name) {
        // 同名・同バージョンの重複は1つにまとめる
        const key = `${name}@${version}`;
        if (!packages.has(key)) {
          packages.set(key, { name, version });
        }
      }
    }
  } else if (lockData.dependencies) {
    // lockfileVersion 1 は dependencies フィールドを使用
    collectDependencies(lockData.dependencies, packages);
  }

  return Array.from(packages.values());
}

/**
 * lockfileVersion 1のdependenciesを再帰的に収集する
 * @param {object} dependencies
 * @param {Map} packages
 */
function collectDependencies(dependencies, packages) {
  for (const [name, info] of Object.entries(dependencies)) {
    const version = info.version;
    if (name && version) {
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        packages.set(key, { name, version });
      }
    }
    if (info.dependencies) {
      collectDependencies(info.dependencies, packages);
    }
  }
}

/**
 * descriptorからパッケージ名を取得する
 * 例: "pkg@^1.0.0" → "pkg", "@scope/pkg@npm:^1.0.0" → "@scope/pkg"
 * @param {string} descriptor
 * @returns {string|null}
 */
function extractPackageNameFromDescriptor(descriptor) {
  if (descriptor.startsWith('@')) {
    // スコープ付きパッケージ: 2番目の @ までが名前
    const secondAt = descriptor.indexOf('@', 1);
    if (secondAt === -1) return null;
    return descriptor.slice(0, secondAt);
  }
  const at = descriptor.indexOf('@');
  if (at <= 0) return null;
  return descriptor.slice(0, at);
}

/**
 * Yarn Classic (v1) 形式の yarn.lock をパースしてパッケージ一覧を返す
 * @param {string} content
 * @returns {{ name: string, version: string }[]}
 */
function parseYarnClassic(content) {
  const packages = new Map();
  const lines = content.split('\n');

  let currentDescriptors = [];
  let currentVersion = null;

  function flushBlock() {
    if (currentVersion && currentDescriptors.length > 0) {
      for (const descriptor of currentDescriptors) {
        const name = extractPackageNameFromDescriptor(descriptor);
        if (name) {
          const key = `${name}@${currentVersion}`;
          if (!packages.has(key)) {
            packages.set(key, { name, version: currentVersion });
          }
        }
      }
    }
    currentDescriptors = [];
    currentVersion = null;
  }

  for (const line of lines) {
    if (line === '' || line.startsWith('#')) {
      flushBlock();
      continue;
    }

    if (!line.startsWith(' ')) {
      // descriptor行: pkg@range, "pkg@range1", "pkg@range2":
      flushBlock();
      const descriptorLine = line.replace(/:$/, '');
      for (const raw of descriptorLine.split(/,\s*/)) {
        const cleaned = raw.replace(/^"/, '').replace(/"$/, '').trim();
        if (cleaned) currentDescriptors.push(cleaned);
      }
    } else {
      // version "x.y.z"
      const versionMatch = line.match(/^\s+version "(.+)"$/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
      }
    }
  }

  flushBlock();
  return Array.from(packages.values());
}

/**
 * Yarn Berry (v2+) 形式の yarn.lock をパースしてパッケージ一覧を返す
 * @param {string} content
 * @returns {{ name: string, version: string }[]}
 */
function parseYarnBerry(content) {
  const packages = new Map();
  const lines = content.split('\n');

  let currentDescriptor = null;
  let currentVersion = null;
  let currentLinkType = null;
  let inMetadata = false;

  function flushBlock() {
    if (currentDescriptor && currentVersion && currentLinkType === 'hard') {
      const name = extractPackageNameFromDescriptor(currentDescriptor);
      if (name) {
        const key = `${name}@${currentVersion}`;
        if (!packages.has(key)) {
          packages.set(key, { name, version: currentVersion });
        }
      }
    }
    currentDescriptor = null;
    currentVersion = null;
    currentLinkType = null;
  }

  for (const line of lines) {
    if (line === '' || line.startsWith('#')) {
      flushBlock();
      inMetadata = false;
      continue;
    }

    if (!line.startsWith(' ')) {
      flushBlock();
      if (line === '__metadata:') {
        inMetadata = true;
      } else {
        inMetadata = false;
        currentDescriptor = line.replace(/:$/, '').replace(/^"/, '').replace(/"$/, '');
      }
    } else if (!inMetadata) {
      // version: x.y.z または version: "x.y.z"
      const versionMatch = line.match(/^\s+version:\s+"?([^"]+)"?\s*$/);
      if (versionMatch) {
        currentVersion = versionMatch[1].trim();
      }
      const linkTypeMatch = line.match(/^\s+linkType:\s+(\S+)$/);
      if (linkTypeMatch) {
        currentLinkType = linkTypeMatch[1];
      }
    }
  }

  flushBlock();
  return Array.from(packages.values());
}

/**
 * yarn.lockを読み込んでパッケージ一覧を返す（Yarn Classic・Yarn Berry両対応）
 * @param {string} lockfilePath
 * @returns {{ name: string, version: string }[]}
 */
function readYarnLock(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`yarn.lock not found at: ${lockfilePath}`);
  }

  const content = fs.readFileSync(lockfilePath, 'utf8');

  // __metadata: ブロックがあればYarn Berry形式
  if (content.includes('__metadata:')) {
    return parseYarnBerry(content);
  }
  return parseYarnClassic(content);
}

/**
 * 指定された並行数でPromiseを実行する
 * @param {Array} items
 * @param {number} concurrency
 * @param {Function} fn
 * @returns {Promise<Array>}
 */
async function runWithConcurrencyLimit(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * package-lock.json内の全パッケージが指定時間以上前にリリースされているか確認する
 * @param {number} minAgeHours - 最低経過時間（時間単位）
 * @returns {Promise<void>}
 */
async function checkPackageAges(minAgeHours) {
  const cwd = process.cwd();
  const yarnLockPath = path.resolve(cwd, 'yarn.lock');
  const packageLockPath = path.resolve(cwd, 'package-lock.json');

  let packages;
  let lockfileName;
  if (fs.existsSync(yarnLockPath)) {
    packages = readYarnLock(yarnLockPath);
    lockfileName = 'yarn.lock';
  } else {
    packages = readPackageLock(packageLockPath);
    lockfileName = 'package-lock.json';
  }

  if (packages.length === 0) {
    process.stdout.write(`No packages found in ${lockfileName}\n`);
    process.exit(0);
  }

  process.stdout.write(`Checking ${packages.length} packages (minimum age: ${minAgeHours} hours)...\n`);

  const nowMs = Date.now();
  const minAgeMs = minAgeHours * 60 * 60 * 1000;
  const tooNewPackages = [];

  const CONCURRENCY = 10;

  await runWithConcurrencyLimit(packages, CONCURRENCY, async ({ name, version }) => {
    let releaseDate;
    try {
      releaseDate = await fetchReleaseDate(name, version);
    } catch (err) {
      process.stderr.write(`Warning: Could not fetch release date for ${name}@${version}: ${err.message}\n`);
      return;
    }

    const ageMs = nowMs - releaseDate.getTime();
    if (ageMs < minAgeMs) {
      const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(2);
      const releasedAt = releaseDate.toISOString();
      tooNewPackages.push({ name, version, ageHours, releasedAt });
    }
  });

  if (tooNewPackages.length > 0) {
    for (const pkg of tooNewPackages) {
      process.stderr.write(
        `FAIL: ${pkg.name}@${pkg.version} was released ${pkg.ageHours} hours ago (${pkg.releasedAt}), minimum required: ${minAgeHours} hours\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write(`All ${packages.length} packages have been released for at least ${minAgeHours} hours.\n`);
  process.exit(0);
}

module.exports = { checkPackageAges, readPackageLock, readYarnLock, fetchReleaseDate };
