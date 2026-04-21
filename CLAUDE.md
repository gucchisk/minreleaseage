# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
# CLI を直接実行（testdata ディレクトリで実行する例）
cd testdata && node ../bin/minreleaseage.js 24

# テスト（package.json の scripts.test が定義されていれば）
node test.js
```

## アーキテクチャ

このツールは `package-lock.json` 内の全パッケージが指定時間（時間単位）以上前にリリースされているかを npm registry で検証する CLI。

### データフロー

```
bin/minreleaseage.js（CLI引数パース）
  └─ checkPackageAges(minAgeHours)  [index.js]
       ├─ readPackageLock()  → { name, version }[] のリストを返す
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

### testdata/

`testdata/` はツールの動作確認用のダミープロジェクト（axios を依存として持つ）。`minreleaseage` は `package-lock.json` が存在するディレクトリで実行する。
