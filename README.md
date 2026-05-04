# minreleaseage

A CLI tool to verify that every package in your lockfile was published to npm at least N hours ago — helping protect against [supply-chain attacks](https://en.wikipedia.org/wiki/Supply_chain_attack) that exploit newly-published malicious versions.

## Usage

Run with `npx` — no installation required:

```bash
npx @gucchisk/minreleaseage <age> [--dir <path>]
```

| Argument / Option | Description |
|---|---|
| `age` | Minimum time since each package was published. Supports `h` (hours), `d` (days), `w` (weeks), or a plain number (treated as hours). |
| `--dir <path>` | Directory containing the lockfile (default: current directory) |

### Example

```bash
# Require all packages to have been published at least 24 hours ago
cd my-project
npx @gucchisk/minreleaseage 24h

# Equivalent: plain number is treated as hours (backward compatible)
npx @gucchisk/minreleaseage 24

# Using days or weeks
npx @gucchisk/minreleaseage 1d   # 1 day  = 24 hours
npx @gucchisk/minreleaseage 1w   # 1 week = 168 hours

# Or specify the directory directly without cd
npx @gucchisk/minreleaseage 1d --dir ./my-project
```

To pin the version, install as a dev dependency and add a script:

```bash
npm install --save-dev @gucchisk/minreleaseage
```

```json
{
  "scripts": {
    "check-pkg-age": "minreleaseage 1d"
  }
}
```

**Output when all packages pass:**
```
Checking 312 packages (minimum age: 24 hours)...
All 312 packages have been released for at least 24 hours.
```

**Output when a package is too new:**
```
Checking 312 packages (minimum age: 24 hours)...
FAIL: some-package@1.2.3 was released 0.42 hours ago (2024-01-15T10:30:00.000Z), minimum required: 24 hours
```

Exit code `1` is returned when any package fails the check.

## Supported lockfiles

| Lockfile | Package manager |
|---|---|
| `pnpm-lock.yaml` (v5/v6/v7/v8/v9) | pnpm |
| `yarn.lock` (Yarn Classic v1) | Yarn 1.x |
| `yarn.lock` (Yarn Berry v2+) | Yarn 2 / 3 / 4 |
| `package-lock.json` (v1/v2/v3) | npm |

Priority order: `pnpm-lock.yaml` → `yarn.lock` → `package-lock.json`

## Use in CI

Add a step to your pipeline to block deployments when a recently-published package appears in the lockfile:

### GitHub Actions

```yaml
- name: Check minimum package release age
  run: npx @gucchisk/minreleaseage 1d
```

## Programmatic API

```js
const { checkPackageAges } = require('@gucchisk/minreleaseage');

// Throws / calls process.exit internally — best used as a CLI
await checkPackageAges(24);

// Optionally specify a directory
await checkPackageAges(24, './my-project');
```

## How it works

1. Reads all packages from the lockfile in the current directory.
2. Deduplicates entries by `name@version`.
3. Determines the registry URL for each package (see [Registry selection](#registry-selection) below).
4. Fetches the publish timestamp from the registry (10 concurrent requests).
5. Compares each timestamp against `Date.now() - minAgeHours`.
6. Reports failures to stderr and exits with code `1` if any package is too new.

No external dependencies — only Node.js built-ins (`fs`, `path`, `https`).

## Registry selection

The registry used to fetch package metadata is determined per lockfile type. Only HTTPS registries are supported.

| Lockfile | Registry source |
|---|---|
| `package-lock.json` | `resolved` field URL in each package entry |
| `yarn.lock` (Classic) | `resolved` field URL in each package entry |
| `yarn.lock` (Berry) | `npmRegistryServer` in `.yarnrc.yml` |
| `pnpm-lock.yaml` | `registry` in `.npmrc` |

If a registry URL cannot be determined (field absent or file not found), `https://registry.npmjs.org` is used as the default.

## License

MIT
