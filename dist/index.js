'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchReleaseDate = fetchReleaseDate;
exports.readPackageLock = readPackageLock;
exports.readYarnLock = readYarnLock;
exports.readPnpmLock = readPnpmLock;
exports.checkPackageAges = checkPackageAges;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const https = __importStar(require("https"));
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
                    }
                    else {
                        reject(new Error(`Release time not found for ${packageName}@${version}`));
                    }
                }
                catch (e) {
                    reject(new Error(`Failed to parse registry response for ${packageName}: ${e.message}`));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`Network error fetching ${packageName}: ${err.message}`));
        });
    });
}
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
            if (pkgPath === '')
                continue;
            if (pkgInfo.link)
                continue;
            const version = pkgInfo.version;
            if (!version)
                continue;
            // pkgInfo.name があればそれを使用、なければパスの最後の node_modules/ 以降を取得
            const name = pkgInfo.name || pkgPath.replace(/^.*node_modules\//, '');
            if (name) {
                const key = `${name}@${version}`;
                if (!packages.has(key)) {
                    packages.set(key, { name, version });
                }
            }
        }
    }
    else if (lockData.dependencies) {
        // lockfileVersion 1 は dependencies フィールドを使用
        collectDependencies(lockData.dependencies, packages);
    }
    return Array.from(packages.values());
}
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
function extractPackageNameFromDescriptor(descriptor) {
    if (descriptor.startsWith('@')) {
        // スコープ付きパッケージ: 2番目の @ までが名前
        const secondAt = descriptor.indexOf('@', 1);
        if (secondAt === -1)
            return null;
        return descriptor.slice(0, secondAt);
    }
    const at = descriptor.indexOf('@');
    if (at <= 0)
        return null;
    return descriptor.slice(0, at);
}
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
                if (cleaned)
                    currentDescriptors.push(cleaned);
            }
        }
        else {
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
            }
            else {
                inMetadata = false;
                currentDescriptor = line.replace(/:$/, '').replace(/^"/, '').replace(/"$/, '');
            }
        }
        else if (!inMetadata) {
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
// pnpm-lock.yaml のパッケージキーから name と version を抽出する
// 対応フォーマット:
//   v9:   lodash@4.17.21  /  @scope/pkg@1.0.0  /  react@18.2.0(react-dom@18.2.0)
//   v6-8: /lodash@4.17.21  /  /@scope/pkg@1.0.0  /  /react@18.2.0_react-dom@18.2.0
//   v5:   /lodash/4.17.21  /  /@scope/pkg/1.0.0
function parsePnpmPackageKey(rawKey) {
    // 先頭の / を除去
    const key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey;
    let name;
    let rawVersion;
    if (key.startsWith('@')) {
        // スコープ付きパッケージ: @scope/name@version または @scope/name/version (v5)
        const firstSlash = key.indexOf('/');
        if (firstSlash === -1)
            return null;
        const afterScope = key.slice(firstSlash + 1);
        const atInName = afterScope.indexOf('@');
        const slashInName = afterScope.indexOf('/');
        if (atInName !== -1 && (slashInName === -1 || atInName < slashInName)) {
            // @scope/name@version
            name = key.slice(0, firstSlash + 1 + atInName);
            rawVersion = afterScope.slice(atInName + 1);
        }
        else if (slashInName !== -1) {
            // @scope/name/version (v5)
            name = key.slice(0, firstSlash + 1 + slashInName);
            rawVersion = afterScope.slice(slashInName + 1);
        }
        else {
            return null;
        }
    }
    else {
        // 非スコープ: name@version または name/version (v5)
        const atIndex = key.indexOf('@');
        const slashIndex = key.indexOf('/');
        if (atIndex !== -1 && (slashIndex === -1 || atIndex < slashIndex)) {
            name = key.slice(0, atIndex);
            rawVersion = key.slice(atIndex + 1);
        }
        else if (slashIndex !== -1) {
            name = key.slice(0, slashIndex);
            rawVersion = key.slice(slashIndex + 1);
        }
        else {
            return null;
        }
    }
    // ピア依存サフィックスを除去: _peer@version (v6-8) または (peers...) (v9)
    const version = rawVersion.split('(')[0].split('_')[0];
    if (!name || !version)
        return null;
    return { name, version };
}
function parsePnpmLock(content) {
    const packages = new Map();
    const lines = content.split('\n');
    let inPackagesSection = false;
    for (const line of lines) {
        // トップレベルセクションの検出（インデントなし）
        if (!line.startsWith(' ') && !line.startsWith('\t')) {
            if (line !== '') {
                inPackagesSection = line === 'packages:';
            }
            continue;
        }
        if (!inPackagesSection)
            continue;
        // パッケージキー行: ちょうど2スペースのインデント + キー + ":"
        // 3スペース以上のインデントはパッケージのプロパティなのでスキップ
        if (!line.startsWith('  ') || line.startsWith('   '))
            continue;
        const keyWithColon = line.slice(2);
        if (!keyWithColon.endsWith(':'))
            continue;
        // YAMLクォートを除去
        const rawKey = keyWithColon.slice(0, -1).replace(/^['"]|['"]$/g, '').trim();
        if (!rawKey)
            continue;
        const parsed = parsePnpmPackageKey(rawKey);
        if (!parsed)
            continue;
        const { name, version } = parsed;
        const mapKey = `${name}@${version}`;
        if (!packages.has(mapKey)) {
            packages.set(mapKey, { name, version });
        }
    }
    return Array.from(packages.values());
}
function readPnpmLock(lockfilePath) {
    if (!fs.existsSync(lockfilePath)) {
        throw new Error(`pnpm-lock.yaml not found at: ${lockfilePath}`);
    }
    const content = fs.readFileSync(lockfilePath, 'utf8');
    return parsePnpmLock(content);
}
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
async function checkPackageAges(minAgeHours) {
    const cwd = process.cwd();
    const pnpmLockPath = path.resolve(cwd, 'pnpm-lock.yaml');
    const yarnLockPath = path.resolve(cwd, 'yarn.lock');
    const packageLockPath = path.resolve(cwd, 'package-lock.json');
    let packages;
    let lockfileName;
    if (fs.existsSync(pnpmLockPath)) {
        packages = readPnpmLock(pnpmLockPath);
        lockfileName = 'pnpm-lock.yaml';
    }
    else if (fs.existsSync(yarnLockPath)) {
        packages = readYarnLock(yarnLockPath);
        lockfileName = 'yarn.lock';
    }
    else {
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
        }
        catch (err) {
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
            process.stderr.write(`FAIL: ${pkg.name}@${pkg.version} was released ${pkg.ageHours} hours ago (${pkg.releasedAt}), minimum required: ${minAgeHours} hours\n`);
        }
        process.exit(1);
    }
    process.stdout.write(`All ${packages.length} packages have been released for at least ${minAgeHours} hours.\n`);
    process.exit(0);
}
