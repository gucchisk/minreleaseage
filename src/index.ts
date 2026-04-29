'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

export interface Package {
  name: string;
  version: string;
  registryUrl?: string;
}

interface TooNewPackage {
  name: string;
  version: string;
  ageHours: string;
  releasedAt: string;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// resolved URL (e.g. https://my-registry.com/path/pkgname/-/pkgname-1.0.0.tgz) から
// レジストリベースURL (e.g. https://my-registry.com/path) を抽出する
function extractRegistryFromResolvedUrl(resolvedUrl: string, packageName: string): string | undefined {
  try {
    const urlWithoutHash = resolvedUrl.split('#')[0];
    const pkgPathSegment = `/${packageName}/`;
    const idx = urlWithoutHash.indexOf(pkgPathSegment);
    if (idx !== -1) {
      const base = urlWithoutHash.slice(0, idx);
      if (base.startsWith('http')) return base;
    }
  } catch {
    // ignore
  }
  return undefined;
}

// .npmrc の registry= からレジストリURLを読み取る
function readNpmrcRegistry(dir: string): string | undefined {
  const npmrcPath = path.join(dir, '.npmrc');
  if (!fs.existsSync(npmrcPath)) return undefined;
  const content = fs.readFileSync(npmrcPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*registry\s*=\s*(.+?)\s*$/);
    if (match) {
      return match[1].replace(/\/$/, '');
    }
  }
  return undefined;
}

// .yarnrc.yml の npmRegistryServer: からレジストリURLを読み取る
function readYarnrcYmlRegistry(dir: string): string | undefined {
  const yarnrcPath = path.join(dir, '.yarnrc.yml');
  if (!fs.existsSync(yarnrcPath)) return undefined;
  const content = fs.readFileSync(yarnrcPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*npmRegistryServer\s*:\s*["']?(.+?)["']?\s*$/);
    if (match) {
      return match[1].replace(/\/$/, '');
    }
  }
  return undefined;
}

export function fetchReleaseDate(
  packageName: string,
  version: string,
  registryUrl: string = DEFAULT_REGISTRY
): Promise<Date> {
  return new Promise((resolve, reject) => {
    // スコープ付きパッケージ (@scope/name) は / を %2F にエンコードする
    const encodedName = packageName.startsWith('@')
      ? packageName.replace('/', '%2F')
      : packageName;
    const url = `${registryUrl}/${encodedName}`;

    const options = {
      headers: {
        // time フィールドを含む完全なpackumentを要求する
        Accept: 'application/json',
      },
    };

    const transport = url.startsWith('https://') ? https : http;
    transport.get(url, options, (res) => {
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
      if (!name) continue;

      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        const resolved = pkgInfo.resolved as string | undefined;
        const registryUrl = resolved ? extractRegistryFromResolvedUrl(resolved, name) : undefined;
        const pkg: Package = { name, version };
        if (registryUrl) pkg.registryUrl = registryUrl;
        packages.set(key, pkg);
      }
    }
  } else if (lockData.dependencies) {
    // lockfileVersion 1 は dependencies フィールドを使用
    collectDependenciesPackageLock(lockData.dependencies, packages);
  }

  return Array.from(packages.values());
}

function collectDependenciesPackageLock(
  dependencies: Record<string, { version?: string; resolved?: string; dependencies?: Record<string, unknown> }>,
  packages: Map<string, Package>
): void {
  for (const [name, info] of Object.entries(dependencies)) {
    const version = info.version;
    if (name && version) {
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        const registryUrl = info.resolved ? extractRegistryFromResolvedUrl(info.resolved, name) : undefined;
        const pkg: Package = { name, version };
        if (registryUrl) pkg.registryUrl = registryUrl;
        packages.set(key, pkg);
      }
    }
    if (info.dependencies) {
      collectDependenciesPackageLock(
        info.dependencies as Record<string, { version?: string; resolved?: string; dependencies?: Record<string, unknown> }>,
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
  const lines = content.split(/\r?\n/);

  let currentDescriptors: string[] = [];
  let currentVersion: string | null = null;
  let currentResolved: string | null = null;

  function flushBlock(): void {
    if (currentVersion && currentDescriptors.length > 0) {
      // 最初の有効なdescriptorからパッケージ名を取得し、registryUrlを抽出する
      let registryUrl: string | undefined;
      if (currentResolved) {
        for (const descriptor of currentDescriptors) {
          const name = extractPackageNameFromDescriptor(descriptor);
          if (name) {
            registryUrl = extractRegistryFromResolvedUrl(currentResolved, name);
            break;
          }
        }
      }

      for (const descriptor of currentDescriptors) {
        const name = extractPackageNameFromDescriptor(descriptor);
        if (name) {
          const key = `${name}@${currentVersion}`;
          if (!packages.has(key)) {
            const pkg: Package = { name, version: currentVersion as string };
            if (registryUrl) pkg.registryUrl = registryUrl;
            packages.set(key, pkg);
          }
        }
      }
    }
    currentDescriptors = [];
    currentVersion = null;
    currentResolved = null;
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
      const versionMatch = line.match(/^\s+version "(.+)"$/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
      }
      const resolvedMatch = line.match(/^\s+resolved "(.+)"$/);
      if (resolvedMatch) {
        currentResolved = resolvedMatch[1];
      }
    }
  }

  flushBlock();
  return Array.from(packages.values());
}

function parseYarnBerry(content: string, registryUrl: string | undefined): Package[] {
  const packages = new Map<string, Package>();
  const lines = content.split(/\r?\n/);

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
          const pkg: Package = { name, version: currentVersion as string };
          if (registryUrl) pkg.registryUrl = registryUrl;
          packages.set(key, pkg);
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
    const registryUrl = readYarnrcYmlRegistry(path.dirname(lockfilePath));
    return parseYarnBerry(content, registryUrl);
  }
  return parseYarnClassic(content);
}

// pnpm-lock.yaml のパッケージキーから name と version を抽出する
// 対応フォーマット:
//   v9:   lodash@4.17.21  /  @scope/pkg@1.0.0  /  react@18.2.0(react-dom@18.2.0)
//   v6-8: /lodash@4.17.21  /  /@scope/pkg@1.0.0  /  /react@18.2.0_react-dom@18.2.0
//   v5:   /lodash/4.17.21  /  /@scope/pkg/1.0.0
function parsePnpmPackageKey(rawKey: string): { name: string; version: string } | null {
  const key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey;

  let name: string;
  let rawVersion: string;

  if (key.startsWith('@')) {
    // スコープ付きパッケージ: @scope/name@version または @scope/name/version (v5)
    const firstSlash = key.indexOf('/');
    if (firstSlash === -1) return null;
    const afterScope = key.slice(firstSlash + 1);

    const atInName = afterScope.indexOf('@');
    const slashInName = afterScope.indexOf('/');

    if (atInName !== -1 && (slashInName === -1 || atInName < slashInName)) {
      // @scope/name@version
      name = key.slice(0, firstSlash + 1 + atInName);
      rawVersion = afterScope.slice(atInName + 1);
    } else if (slashInName !== -1) {
      // @scope/name/version (v5)
      name = key.slice(0, firstSlash + 1 + slashInName);
      rawVersion = afterScope.slice(slashInName + 1);
    } else {
      return null;
    }
  } else {
    // 非スコープ: name@version または name/version (v5)
    const atIndex = key.indexOf('@');
    const slashIndex = key.indexOf('/');

    if (atIndex !== -1 && (slashIndex === -1 || atIndex < slashIndex)) {
      name = key.slice(0, atIndex);
      rawVersion = key.slice(atIndex + 1);
    } else if (slashIndex !== -1) {
      name = key.slice(0, slashIndex);
      rawVersion = key.slice(slashIndex + 1);
    } else {
      return null;
    }
  }

  // ピア依存サフィックスを除去: _peer@version (v6-8) または (peers...) (v9)
  const version = rawVersion.split('(')[0].split('_')[0];

  if (!name || !version) return null;
  return { name, version };
}

function parsePnpmLock(content: string, registryUrl: string | undefined): Package[] {
  const packages = new Map<string, Package>();
  const lines = content.split(/\r?\n/);

  let inPackagesSection = false;

  for (const line of lines) {
    // トップレベルセクションの検出（インデントなし）
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      if (line !== '') {
        inPackagesSection = line === 'packages:';
      }
      continue;
    }

    if (!inPackagesSection) continue;

    // パッケージキー行: ちょうど2スペースのインデント + キー + ":"
    // 3スペース以上のインデントはパッケージのプロパティなのでスキップ
    if (!line.startsWith('  ') || line.startsWith('   ')) continue;

    const keyWithColon = line.slice(2);
    if (!keyWithColon.endsWith(':')) continue;
    // YAMLクォートを除去
    const rawKey = keyWithColon.slice(0, -1).replace(/^['"]|['"]$/g, '').trim();
    if (!rawKey) continue;

    const parsed = parsePnpmPackageKey(rawKey);
    if (!parsed) continue;

    const { name, version } = parsed;
    const mapKey = `${name}@${version}`;
    if (!packages.has(mapKey)) {
      const pkg: Package = { name, version };
      if (registryUrl) pkg.registryUrl = registryUrl;
      packages.set(mapKey, pkg);
    }
  }

  return Array.from(packages.values());
}

export function readPnpmLock(lockfilePath: string): Package[] {
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`pnpm-lock.yaml not found at: ${lockfilePath}`);
  }

  const content = fs.readFileSync(lockfilePath, 'utf8');
  const registryUrl = readNpmrcRegistry(path.dirname(lockfilePath));
  return parsePnpmLock(content, registryUrl);
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

export async function checkPackageAges(minAgeHours: number, targetDir?: string): Promise<void> {
  const cwd = targetDir ? path.resolve(targetDir) : process.cwd();
  const pnpmLockPath = path.resolve(cwd, 'pnpm-lock.yaml');
  const yarnLockPath = path.resolve(cwd, 'yarn.lock');
  const packageLockPath = path.resolve(cwd, 'package-lock.json');

  let packages: Package[];
  let lockfileName: string;
  if (fs.existsSync(pnpmLockPath)) {
    packages = readPnpmLock(pnpmLockPath);
    lockfileName = 'pnpm-lock.yaml';
  } else if (fs.existsSync(yarnLockPath)) {
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

  await runWithConcurrencyLimit(packages, CONCURRENCY, async (pkg) => {
    const { name, version, registryUrl } = pkg;
    let releaseDate: Date;
    try {
      releaseDate = await fetchReleaseDate(name, version, registryUrl);
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
    for (const tooNewPkg of tooNewPackages) {
      process.stderr.write(
        `FAIL: ${tooNewPkg.name}@${tooNewPkg.version} was released ${tooNewPkg.ageHours} hours ago (${tooNewPkg.releasedAt}), minimum required: ${minAgeHours} hours\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write(`All ${packages.length} packages have been released for at least ${minAgeHours} hours.\n`);
  process.exit(0);
}
