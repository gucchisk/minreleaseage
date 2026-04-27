# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
# CLI を直接実行（testdata/npm ディレクトリで実行する例）
cd testdata/npm && node ../../bin/minreleaseage.js 24

# テスト（package.json の scripts.test が定義されていれば）
node test.js
```

## アーキテクチャ

このツールは lockfile（`pnpm-lock.yaml`、`yarn.lock`、`package-lock.json`）内の全パッケージが指定時間（時間単位）以上前にリリースされているかを npm registry で検証する CLI。サプライチェーン攻撃対策が目的。

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
bin/minreleaseage.js（CLI引数パース）
  └─ checkPackageAges(minAgeHours)  [index.js]
       ├─ pnpm-lock.yaml が存在する場合: readPnpmLock()  → { name, version }[]
       │    └─ parsePnpmLock(): packages: セクションのキーを解析
       │         （v9: name@version / v6-8: /name@version / v5: /name/version）
       ├─ yarn.lock が存在する場合: readYarnLock()  → { name, version }[]
       │    ├─ __metadata: ブロックあり → parseYarnBerry()
       │    └─ なし              → parseYarnClassic()
       ├─ それ以外: readPackageLock()  → { name, version }[]
       │    ├─ lockfileVersion 2+: packages フィールドを使用
       │    └─ lockfileVersion 1: dependencies フィールドを再帰的に収集
       └─ runWithConcurrencyLimit(packages, 10, ...)  → 並行数10でフェッチ
            └─ fetchReleaseDate(name, version)
                 └─ GET https://registry.npmjs.org/<name>  の time[version] を参照
```

### 重要な実装詳細

- **スコープ付きパッケージ**: `@scope/name` 形式は `/` を `%2F` にエンコードして registry に問い合わせる
- **重複排除**: `name@version` をキーにした `Map` で同名・同バージョンを1つに集約
- **終了コード**: 問題なし → `exit(0)`、古さ不足パッケージあり → `exit(1)`
- **外部依存**: なし（Node.js 標準ライブラリ `fs`, `path`, `https` のみ使用）

### 注意点
- 機能追加・修正・削除を行った場合は、このCLAUDE.md、README.mdの更新を必ず確認して行う

### testdata/

`testdata/` はツールの動作確認用のダミープロジェクト。`minreleaseage` は lockfile が存在するディレクトリで実行する。

- `testdata/npm/` — npm（`package-lock.json`）
- `testdata/yarn-classic/` — Yarn Classic（`yarn.lock`）
- `testdata/yarn-berry/` — Yarn Berry（`yarn.lock`）
- `testdata/pnpm/` — pnpm（`pnpm-lock.yaml`）
