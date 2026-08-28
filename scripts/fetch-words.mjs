#!/usr/bin/env node
/**
 * scripts/fetch-words.mjs
 *
 * JMdict-simplified (https://github.com/scriptin/jmdict-simplified) の
 * 最新リリースから英日辞書データをダウンロードし、
 * 「よく使われる一般名詞」だけを抽出して words.json を作り直します。
 *
 * 使い方:
 *   npm install
 *   npm run fetch-words
 *
 * 生成物: ../words.json (プロジェクトルート、既存ファイルを上書きします)
 *
 * 注意:
 * - JMdict は Electronic Dictionary Research and Development Group (EDRDG) が
 *   CC BY-SA 4.0 で配布しているデータです。配布・公開する場合は
 *   https://www.edrdg.org/jmdict/edict_doc.html のクレジット表記に従ってください。
 * - gloss(意味)は英語のみです。日本語の意味が欲しい語は、words.json を
 *   手動で編集するか、curated (手作業で意味を付けた) リストと合体させてください。
 * - Node.js 18 以降 (fetch 標準搭載) が必要です。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REPO = 'scriptin/jmdict-simplified';
const MAX_WORDS = 4000; // しりとりが破綻しない程度に上限を設定。増減は自由

async function getLatestAsset(){
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'shiritori-dojo-fetch-words' }
  });
  if(!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const asset =
    data.assets.find(a => /^jmdict-eng-common-.*\.json\.zip$/.test(a.name)) ||
    data.assets.find(a => /^jmdict-eng-.*\.json\.zip$/.test(a.name));
  if(!asset) throw new Error('対応する jmdict-eng の zip アセットが見つかりませんでした。リポジトリのリリースページを確認してください。');
  return asset;
}

function toHiragana(str){
  return str.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

async function main(){
  console.log('最新リリース情報を取得中…');
  const asset = await getLatestAsset();
  console.log(`ダウンロード: ${asset.name} (${(asset.size/1024/1024).toFixed(1)} MB)`);

  const zipRes = await fetch(asset.browser_download_url);
  const buf = Buffer.from(await zipRes.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
  if(!entry) throw new Error('zip内にjsonファイルが見つかりませんでした');

  console.log('展開・解析中…');
  const data = JSON.parse(zip.readAsText(entry));
  console.log(`収録エントリ数: ${data.words.length}`);

  const out = [];
  const seenReadings = new Set();

  for(const word of data.words){
    const kanjiCommon = (word.kanji || []).find(k => k.common);
    const kanaCommon = (word.kana || []).find(k => k.common);
    if(!kanaCommon) continue; // 「よく使われる」語だけを対象にする

    const reading = toHiragana(kanaCommon.text);
    if(!/^[ぁ-ゖー]+$/.test(reading)) continue; // 純粋なかな以外(記号混じり等)は除外
    if(reading.length < 2) continue;             // 1文字語は除外
    if(seenReadings.has(reading)) continue;       // 読みの重複を避ける

    const isNoun = word.sense.some(s => (s.partOfSpeech || []).some(p => p.includes('n')));
    if(!isNoun) continue;

    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;

    seenReadings.add(reading);
    out.push({
      w: (kanjiCommon && kanjiCommon.text) || kanaCommon.text,
      r: reading,
      m: gloss.text
    });
    if(out.length >= MAX_WORDS) break;
  }

  console.log(`抽出できた語数: ${out.length}`);
  const outPath = path.join(ROOT, 'words.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`書き出し完了: ${outPath}`);
}

main().catch(err => { console.error('失敗:', err.message); process.exit(1); });
