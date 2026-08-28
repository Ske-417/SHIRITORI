# 辞書番 -しりとり道場-

API不使用・完全オフラインで動くしりとり対戦アプリ。

## 構成

```
index.html          画面本体
style.css            スタイル
script.js             ゲームロジック(判定・辞書番のAI思考)
words.json            辞書番(AI)が手を選ぶための語彙データ
scripts/fetch-words.mjs  words.json を自動生成するビルドスクリプト
```

## ルール仕様(重要)

- **あなたの入力は「実在する言葉である」と信頼し、辞書と照合して合否判定はしません。**
  読み(かな)を特定する必要があるため、ひらがな/カタカナでの入力を前提にしています。
  (辞書に載っている語を漢字で打った場合は辞書の読みを流用します)
- 読みの先頭が直前の語の指定音と一致しているか、既出でないかはチェックします。
- **読みが「ん」で終わった側が、その場で負けになります。** あなた・辞書番どちらの場合も判定します。
- 辞書番(AI)は `words.json` の中からしか手を選べません。強さ「めちゃ強い」は、
  次の一手を選ぶ際に「その手を打つとあなたの返せる語が何個残るか」を計算し、
  一番少なくなる手を選ぶ簡易な先読み(1手読み)で実現しています。

## 開発環境での起動

`fetch` で `words.json` を読み込むため、`file://` で直接開くとブラウザによっては
CORSエラーになります。簡易サーバー経由で開いてください。

```bash
npm install
npm run serve
# → http://localhost:3000 などが表示されるのでブラウザで開く
```

VSCode を使うなら「Live Server」拡張機能でも同様に動きます。

## 語彙を増やす(自動化)

`words.json` は手作業で書いた約180語です。もっと語彙を増やしたい場合、
[JMdict-simplified](https://github.com/scriptin/jmdict-simplified)(オープンな日英辞書データ、
CC BY-SA 4.0)から「よく使われる一般名詞」を自動抽出するスクリプトを用意しています。

```bash
npm install
npm run fetch-words
```

これで `words.json` が数千語規模に置き換わります。**このスクリプトの実行にAIやAPIトークンは
一切使いません。GitHubから公開データをダウンロードして加工するだけのビルドステップです。**

### 既知のトレードオフ

- JMdictの意味(gloss)は英語のみです。取得した語は英語の意味がそのまま入ります。
  日本語の意味にこだわるなら、手作業で意味を付けた既存の約180語(コア辞書)と
  自動取得分をマージし、コア辞書を優先するなどの工夫が必要です。
- 固有名詞・専門用語・古い言葉なども混ざるので、必要に応じてフィルタ条件
  (`scripts/fetch-words.mjs` 内の `isNoun` 判定や除外リストなど)を調整してください。

## ライセンス表記

`words.json` を JMdict由来のデータで再生成した場合は、EDRDGの利用条件に従い
クレジット表記(例: "This application uses the JMdict dictionary files.
These files are the property of the Electronic Dictionary Research and
Development Group, and are used in conformance with the Group's licence.")
をどこかに残してください。
