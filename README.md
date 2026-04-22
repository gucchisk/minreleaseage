# minreleaseage

A CLI tool to verify that every package in your lockfile was published to npm at least N hours ago — helping protect against [supply-chain attacks](https://en.wikipedia.org/wiki/Supply_chain_attack) that exploit newly-published malicious versions.

## Usage

Run with `npx` — no installation required:

```bash
npx @gucchisk/minreleaseage <age_in_hours>
```

| Argument | Description |
|---|---|
| `age_in_hours` | Minimum number of hours since each package was published |

### Example

```bash
# Require all packages to have been published at least 24 hours ago
cd my-project
npx @gucchisk/minreleaseage 24
```

To pin the version, install as a dev dependency and add a script:

```bash
npm install --save-dev @gucchisk/minreleaseage
```

```json
{
  "scripts": {
    "check-pkg-age": "minreleaseage 24"
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
| `yarn.lock` (Yarn Classic v1) | Yarn 1.x |
| `yarn.lock` (Yarn Berry v2+) | Yarn 2 / 3 / 4 |
| `package-lock.json` (v1/v2/v3) | npm |

If `yarn.lock` exists in the current directory it takes precedence. Otherwise `package-lock.json` is used.

## Use in CI

Add a step to your pipeline to block deployments when a recently-published package appears in the lockfile:

### GitHub Actions

```yaml
- name: Check minimum package release age
  run: npx @gucchisk/minreleaseage 24
```

## Programmatic API

```js
const { checkPackageAges } = require('@gucchisk/minreleaseage');

// Throws / calls process.exit internally — best used as a CLI
await checkPackageAges(24);
```

## How it works

1. Reads all packages from the lockfile in the current directory.
2. Deduplicates entries by `name@version`.
3. Fetches the publish timestamp from `https://registry.npmjs.org/<name>` (10 concurrent requests).
4. Compares each timestamp against `Date.now() - minAgeHours`.
5. Reports failures to stderr and exits with code `1` if any package is too new.

No external dependencies — only Node.js built-ins (`fs`, `path`, `https`).

## License

MIT
