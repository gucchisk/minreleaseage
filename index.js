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
  const lockfilePath = path.resolve(process.cwd(), 'package-lock.json');
  const packages = readPackageLock(lockfilePath);

  if (packages.length === 0) {
    process.stdout.write('No packages found in package-lock.json\n');
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

module.exports = { checkPackageAges, readPackageLock, fetchReleaseDate };
