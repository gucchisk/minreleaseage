# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
# CLI を直接実行（testdata/npm ディレクトリで実行する例）
cd testdata/npm && node ../../dist/cli.js 24

# --dir オプションで直接ディレクトリ指定
node dist/cli.js 24 --dir ./testdata/npm

# テスト
npm test
npm run test:unit
npm run test:e2e
```

## アーキテクチャ

このツールは lockfile（`pnpm-lock.yaml`、`yarn.lock`、`package-lock.json`）内の全パッケージが指定時間（時間単位）以上前にリリースされているかを registry で検証する CLI。サプライチェーン攻撃対策が目的。

### 対応 lockfile

| ファイル | パッケージマネージャ |
|---|---|
| `pnpm-lock.yaml`（v5/v6/v7/v8/v9） | pnpm |
| `yarn.lock`（Yarn Classic v1 形式） | Yarn 1.x |
| `yarn.lock`（Yarn Berry v2+ 形式） | Yarn 2 / 3 / 4 |
| `package-lock.json`（v1/v2/v3） | npm |

優先順位: `pnpm-lock.yaml` → `yarn.lock` → `package-lock.json`

### データフロー

```
dist/cli.js（CLI引数パース: <age_in_hours> [--dir <path>]）
  └─ checkPackageAges(minAgeHours, targetDir?)  [index.js]
       ├─ pnpm-lock.yaml が存在する場合: readPnpmLock()  → { name, version, registryUrl? }[]
       │    ├─ readNpmrcRegistry(): .npmrc の registry= からレジストリURLを取得
       │    └─ parsePnpmLock(): packages: セクションのキーを解析
       │         （v9: name@version / v6-8: /name@version / v5: /name/version）
       ├─ yarn.lock が存在する場合: readYarnLock()  → { name, version, registryUrl? }[]
       │    ├─ __metadata: ブロックあり → readYarnrcYmlRegistry() で .yarnrc.yml の
       │    │                             npmRegistryServer: を取得 → parseYarnBerry()
       │    └─ なし              → parseYarnClassic()
       │         └─ resolved フィールドの URL からレジストリURLを抽出
       ├─ それ以外: readPackageLock()  → { name, version, registryUrl? }[]
       │    ├─ lockfileVersion 2+: packages フィールドを使用
       │    │    └─ resolved フィールドの URL からレジストリURLを抽出
       │    └─ lockfileVersion 1: dependencies フィールドを再帰的に収集
       │         └─ resolved フィールドの URL からレジストリURLを抽出
       └─ runWithConcurrencyLimit(packages, 10, ...)  → 並行数10でフェッチ
            └─ fetchReleaseDate(name, version, registryUrl?)
                 └─ GET <registryUrl>/<name>  の time[version] を参照
                      （registryUrl 未指定時は https://registry.npmjs.org）
```

### 重要な実装詳細

- **スコープ付きパッケージ**: `@scope/name` 形式は `/` を `%2F` にエンコードして registry に問い合わせる
- **重複排除**: `name@version` をキーにした `Map` で同名・同バージョンを1つに集約
- **終了コード**: 問題なし → `exit(0)`、古さ不足パッケージあり → `exit(1)`
- **レジストリURL解決**: lockfile種別により取得元が異なる（下表）。HTTPS のみ対応。`http://` のURLが渡された場合は即エラー

  | lockfile | 取得元 |
  |---|---|
  | `package-lock.json` | 各エントリの `resolved` フィールドURL |
  | `yarn.lock`（Classic）| 各エントリの `resolved` フィールドURL |
  | `yarn.lock`（Berry）| `.yarnrc.yml` の `npmRegistryServer:` |
  | `pnpm-lock.yaml` | `.npmrc` の `registry=` |

  いずれも未設定の場合は `https://registry.npmjs.org` をデフォルトとして使用
- **外部依存**: なし（Node.js 標準ライブラリ `fs`, `path`, `https` のみ使用）

### 注意点
- 機能追加・修正・削除を行った場合は、このCLAUDE.md、README.mdの更新を必ず確認して行う

### testdata/

`testdata/` はツールの動作確認用のダミープロジェクト。`minreleaseage` は lockfile が存在するディレクトリで実行するか、`--dir` オプションで指定する。

- `testdata/npm/` — npm（`package-lock.json`）
- `testdata/yarn-classic/` — Yarn Classic（`yarn.lock`）
- `testdata/yarn-berry/` — Yarn Berry（`yarn.lock`）
- `testdata/pnpm/` — pnpm（`pnpm-lock.yaml`）
