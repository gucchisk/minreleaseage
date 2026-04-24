'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

export interface Package {
  name: string;
  version: string;
}

interface TooNewPackage {
  name: string;
  version: string;
  ageHours: string;
  releasedAt: string;
}

export function fetchReleaseDate(packageName: string, version: string): Promise<Date> {
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
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          // パッケージルートレスポンスの time オブジェクトからバージョンの公開日時を取得する
          const releaseTime: string | undefined = data.time && data.time[version];
          if (releaseTime) {
            resolve(new Date(releaseTime));
          } else {
            reject(new Error(`Release time not found for ${packageName}@${version}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse registry response for ${packageName}: ${(e as Error).message}`));
        }
      });
    }).on('error', (err: Error) => {
      reject(new Error(`Network error fetching ${packageName}: ${err.message}`));
    });
  });
}

export function readPackageLock(lockfilePath: string): Package[] {
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`package-lock.json not found at: ${lockfilePath}`);
  }

  const content = fs.readFileSync(lockfilePath, 'utf8');
  const lockData = JSON.parse(content);

  const packages = new Map<string, Package>();

  // lockfileVersion 2以上は packages フィールドを使用
  if (lockData.packages) {
    for (const [pkgPath, pkgInfo] of Object.entries(lockData.packages) as [string, Record<string, string | boolean>][]) {
      if (pkgPath === '') continue;
      if (pkgInfo.link) continue;

      const version = pkgInfo.version as string | undefined;
      if (!version) continue;

      // pkgInfo.name があればそれを使用、なければパスの最後の node_modules/ 以降を取得
      const name = (pkgInfo.name as string | undefined) || pkgPath.replace(/^.*node_modules\//, '');

      if (name) {
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

function collectDependencies(
  dependencies: Record<string, { version?: string; dependencies?: Record<string, unknown> }>,
  packages: Map<string, Package>
): void {
  for (const [name, info] of Object.entries(dependencies)) {
    const version = info.version;
    if (name && version) {
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        packages.set(key, { name, version });
      }
    }
    if (info.dependencies) {
      collectDependencies(
        info.dependencies as Record<string, { version?: string; dependencies?: Record<string, unknown> }>,
        packages
      );
    }
  }
}

function extractPackageNameFromDescriptor(descriptor: string): string | null {
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

function parseYarnClassic(content: string): Package[] {
  const packages = new Map<string, Package>();
  const lines = content.split('\n');

  let currentDescriptors: string[] = [];
  let currentVersion: string | null = null;

  function flushBlock(): void {
    if (currentVersion && currentDescriptors.length > 0) {
      for (const descriptor of currentDescriptors) {
        const name = extractPackageNameFromDescriptor(descriptor);
        if (name) {
          const key = `${name}@${currentVersion}`;
          if (!packages.has(key)) {
            packages.set(key, { name, version: currentVersion as string });
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

function parseYarnBerry(content: string): Package[] {
  const packages = new Map<string, Package>();
  const lines = content.split('\n');

  let currentDescriptor: string | null = null;
  let currentVersion: string | null = null;
  let currentLinkType: string | null = null;
  let inMetadata = false;

  function flushBlock(): void {
    if (currentDescriptor && currentVersion && currentLinkType === 'hard') {
      const name = extractPackageNameFromDescriptor(currentDescriptor);
      if (name) {
        const key = `${name}@${currentVersion}`;
        if (!packages.has(key)) {
          packages.set(key, { name, version: currentVersion as string });
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

export function readYarnLock(lockfilePath: string): Package[] {
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

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function checkPackageAges(minAgeHours: number): Promise<void> {
  const cwd = process.cwd();
  const yarnLockPath = path.resolve(cwd, 'yarn.lock');
  const packageLockPath = path.resolve(cwd, 'package-lock.json');

  let packages: Package[];
  let lockfileName: string;
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
  const tooNewPackages: TooNewPackage[] = [];

  const CONCURRENCY = 10;

  await runWithConcurrencyLimit(packages, CONCURRENCY, async ({ name, version }) => {
    let releaseDate: Date;
    try {
      releaseDate = await fetchReleaseDate(name, version);
    } catch (err) {
      process.stderr.write(`Warning: Could not fetch release date for ${name}@${version}: ${(err as Error).message}\n`);
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
