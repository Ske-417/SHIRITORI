#!/usr/bin/env node
/**
 * scripts/fetch-words.mjs
 *
 * JMdict-simplified / JMnedict-simplified (https://github.com/scriptin/jmdict-simplified) の
 * 最新リリースから公開データをダウンロードし、しりとりの手として使える語を抽出して
 * words-auto.json を作り直します。
 *
 * 使い方:
 *   npm install
 *   npm run fetch-words
 *
 * 生成物: ../words-auto.json (プロジェクトルート、既存ファイルを上書きします)
 * ※ 手作業で日本語の意味を付けたコア辞書は words-core.json に分離してあり、
 *   このスクリプトが触るのは words-auto.json だけです。
 *
 * 抽出対象:
 *   1. 一般名詞      … jmdict-eng-common から品詞タグが名詞系のものだけ (よく使われる語のみ)
 *   2. ことわざ・故事成語 … jmdict-eng (フル版) から misc タグ "proverb" / "yoji" が付いた語
 *   3. 固有名詞      … jmnedict-all (人名・地名・組織名など) から種別ごとに上限を設けて抽出
 *
 * 注意:
 * - JMdict/JMnedict は Electronic Dictionary Research and Development Group (EDRDG) が
 *   CC BY-SA 4.0 で配布しているデータです。配布・公開する場合は
 *   https://www.edrdg.org/jmdict/edict_doc.html のクレジット表記に従ってください。
 * - gloss(意味)は英語のみです。日本語の意味が欲しい語は words-core.json 側に追加してください。
 * - Node.js 18 以降 (fetch 標準搭載) が必要です。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = 'scriptin/jmdict-simplified';

// しりとりの読みとして許容する文字種(純粋なひらがな+長音のみ)
const KANA_ONLY = /^[ぁ-ゖー]+$/;

// JMdict の partOfSpeech は "n" を含むだけの部分一致で判定すると
// interjection(int)や Noh(noh)、Nagano-ben(nab)まで誤って拾ってしまうため、
// 名詞系タグのみを厳密に列挙する。
const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pref', 'n-suf', 'n-pr']);

// 抽出する語数の上限。多すぎると辞書番の思考(先読み)が重くなるほか、
// あまりに無名な語ばかりになってゲームとして破綻するため種別ごとに上限を設ける。
const CAPS = {
  noun: 6000,
  place: 4000,
  organization: 5000,
  station: 1500,
  person: 2000,
  surname: 3000,
  given: 2000,
  fem: 1500,
  masc: 1000,
  unclass: 500,
};
const CAP_DEFAULT = Infinity; // company / product / work / group など元々件数が少ないものは無制限

const NAME_TYPE_LABEL = {
  place: '地名', organization: '組織名', company: '企業名', product: '製品名',
  work: '作品名', station: '駅名', group: 'グループ名', person: '人名',
  surname: '姓', given: '名', fem: '女性の名', masc: '男性の名', unclass: '固有名詞',
  serv: '固有名詞', obj: '固有名詞', char: '固有名詞', dei: '固有名詞',
  fict: '固有名詞', creat: '固有名詞', myth: '固有名詞', ship: '固有名詞',
  ev: '固有名詞', leg: '固有名詞', doc: '固有名詞',
};
// JMnedict の種別のうち、優先して採用する順序(重複読みは先勝ち)
const NAME_TYPE_PRIORITY = [
  'place', 'organization', 'company', 'product', 'work', 'station', 'group',
  'person', 'surname', 'given', 'fem', 'masc',
  'serv', 'obj', 'char', 'dei', 'fict', 'creat', 'myth', 'ship', 'ev', 'leg', 'doc',
  'unclass',
];

function toHiragana(str){
  return str.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

async function getAsset(nameTest){
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'shiritori-dojo-fetch-words' }
  });
  if(!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const asset = data.assets.find(a => nameTest.test(a.name));
  if(!asset) throw new Error(`対応するアセットが見つかりませんでした(パターン: ${nameTest})`);
  return asset;
}

async function downloadJson(asset){
  console.log(`ダウンロード: ${asset.name} (${(asset.size/1024/1024).toFixed(1)} MB)`);
  const res = await fetch(asset.browser_download_url);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
  if(!entry) throw new Error(`${asset.name} 内にjsonファイルが見つかりませんでした`);
  return JSON.parse(zip.readAsText(entry));
}

function addEntry(out, seenReadings, cap, { w, r, m }){
  if(!KANA_ONLY.test(r)) return false;
  if(r.length < 2) return false;
  if(seenReadings.has(r)) return false;
  if(out.length >= cap) return false;
  seenReadings.add(r);
  out.push({ w, r, m });
  return true;
}

function extractNouns(data, seenReadings){
  const out = [];
  for(const word of data.words){
    if(out.length >= CAPS.noun) break;
    const kanjiCommon = (word.kanji || []).find(k => k.common);
    const kanaCommon = (word.kana || []).find(k => k.common);
    if(!kanaCommon) continue; // 「よく使われる」語だけを対象にする

    const reading = toHiragana(kanaCommon.text);
    const isNoun = word.sense.some(s => (s.partOfSpeech || []).some(p => NOUN_POS.has(p)));
    if(!isNoun) continue;

    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;

    addEntry(out, seenReadings, CAPS.noun, {
      w: (kanjiCommon && kanjiCommon.text) || kanaCommon.text,
      r: reading,
      m: `(en) ${gloss.text}`,
    });
  }
  console.log(`一般名詞: ${out.length}語`);
  return out;
}

function extractProverbsAndYoji(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const isTarget = word.sense.some(s => (s.misc || []).includes('proverb') || (s.misc || []).includes('yoji'));
    if(!isTarget) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: `(en) ${gloss.text}`,
    });
  }
  console.log(`ことわざ・故事成語: ${out.length}語`);
  return out;
}

function primaryNameType(word){
  const types = new Set();
  for(const t of word.translation) for(const ty of (t.type || [])) types.add(ty);
  for(const t of NAME_TYPE_PRIORITY) if(types.has(t)) return t;
  return null;
}

function extractProperNouns(data, seenReadings){
  const buckets = new Map(); // type -> array of {w,r}
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const type = primaryNameType(word);
    if(!type) continue;
    const reading = toHiragana(kana.text);
    if(!KANA_ONLY.test(reading) || reading.length < 2) continue;
    const kanji = word.kanji && word.kanji[0];
    if(!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push({ w: (kanji && kanji.text) || kana.text, r: reading });
  }

  const out = [];
  for(const type of NAME_TYPE_PRIORITY){
    const bucket = buckets.get(type);
    if(!bucket) continue;
    // 短い読みほど平易で「知られている」名前である可能性が高いと見なし優先する
    bucket.sort((a, b) => a.r.length - b.r.length);
    const cap = CAPS[type] ?? CAP_DEFAULT;
    let added = 0;
    for(const cand of bucket){
      if(added >= cap) break;
      if(addEntry(out, seenReadings, Infinity, { w: cand.w, r: cand.r, m: NAME_TYPE_LABEL[type] })) added++;
    }
  }
  console.log(`固有名詞: ${out.length}語`);
  return out;
}

async function main(){
  console.log('最新リリース情報を取得中…');
  const [commonAsset, fullAsset, neAsset] = await Promise.all([
    getAsset(/^jmdict-eng-common-.*\.json\.zip$/),
    getAsset(/^jmdict-eng-\d.*\.json\.zip$/),
    getAsset(/^jmnedict-all-.*\.json\.zip$/),
  ]);

  const [commonData, fullData, neData] = await Promise.all([
    downloadJson(commonAsset),
    downloadJson(fullAsset),
    downloadJson(neAsset),
  ]);

  const seenReadings = new Set();
  const out = [
    ...extractNouns(commonData, seenReadings),
    ...extractProverbsAndYoji(fullData, seenReadings),
    ...extractProperNouns(neData, seenReadings),
  ];

  console.log(`抽出できた語数の合計: ${out.length}`);
  const outPath = path.join(ROOT, 'words-auto.json');
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`書き出し完了: ${outPath}`);
}

main().catch(err => { console.error('失敗:', err.message); process.exit(1); });
