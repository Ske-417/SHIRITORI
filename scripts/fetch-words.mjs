#!/usr/bin/env node
/**
 * scripts/fetch-words.mjs
 *
 * JMdict-simplified / JMnedict-simplified (https://github.com/scriptin/jmdict-simplified) の
 * 最新リリースから公開データをダウンロードし、しりとりの手として使える語を抽出して
 * words-auto.tsv を作り直します。
 *
 * 使い方:
 *   npm install
 *   npm run fetch-words
 *
 * 生成物: ../words-auto.tsv (プロジェクトルート、既存ファイルを上書きします。TSV形式で、
 *   1行目はヘッダー w/r/m/t/d。表計算ソフトで開いて確認・編集しやすくするため
 *   JSONではなくTSVを採用している。詳細は ../tsv.js 参照)
 * ※ 手作業で日本語の意味を付けたコア辞書は words-core.tsv に分離してあり、
 *   このスクリプトが触るのは words-auto.tsv だけです。
 *
 * 抽出対象:
 *   1. 一般名詞      … jmdict-eng-common から品詞タグが名詞系のものだけ (よく使われる語のみ)
 *   2. ことわざ・故事成語 … jmdict-eng (フル版) から misc タグ "proverb" / "yoji" が付いた語
 *   3. 専門用語      … jmdict-eng (フル版) から field タグが専門分野を示す語(医学・化学・
 *                    数学・物理・法律・経済・スポーツ・音楽・ゲームなど FIELD_LABELS 参照)
 *   4. 神話          … jmdict-eng (フル版) から field タグが神話系(ギリシャ/ローマ/中国/日本)の語
 *   5. 固有名詞      … jmnedict-all (地名・組織名など「人でないもの」は種別ごとに上限を設けて全採用。
 *                    人物系(person/surname/given/fem/masc/unclass)は、JMnedict上で
 *                    生没年などの伝記情報が確認できるもの=著名人と判定できるものだけを採用する。
 *                    JMnedictの fem/given/masc/surname はただの名前読み辞書であり無名な人物も
 *                    大量に含まれるため、伝記情報という裏付けが無い語は採用しない)
 *   6. 神話・架空の存在(Wikidata) … Wikidata SPARQL(query.wikidata.org)から、
 *                    「神(Q22989102)」「神話・伝説の生物(Q24334685)」
 *                    「架空のキャラクター(Q95074)」に分類されている項目のうち、
 *                    日本語ラベルが純粋なかな(カタカナ/ひらがな)であるものを採用する。
 *                    JMnedictのchar/myth種別だけでは件数が少なすぎるため補完している。
 *                    Wikidataは CC0(パブリックドメイン相当)で公開されている構造化データ。
 *
 * 注意:
 * - JMdict/JMnedict は Electronic Dictionary Research and Development Group (EDRDG) が
 *   CC BY-SA 4.0 で配布しているデータです。配布・公開する場合は
 *   https://www.edrdg.org/jmdict/edict_doc.html のクレジット表記に従ってください。
 * - Wikidata由来のデータは CC0 です(https://www.wikidata.org/wiki/Wikidata:Licensing)。
 *   query.wikidata.org への負荷を抑えるため、説明文の取得はラベル取得とは別のバッチ
 *   クエリに分けている(1回の巨大なクエリにまとめるとタイムアウトしやすいため)。
 * - gloss(意味)は英語のみです。日本語の意味が欲しい語は words-core.tsv 側に追加してください。
 * - Node.js 18 以降 (fetch 標準搭載) が必要です。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { stringifyTSV } from '../tsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = 'scriptin/jmdict-simplified';

// しりとりの読みとして許容する文字種(純粋なひらがな+長音のみ)
const KANA_ONLY = /^[ぁ-ゖー]+$/;

// JMdict の partOfSpeech は "n" を含むだけの部分一致で判定すると
// interjection(int)や Noh(noh)、Nagano-ben(nab)まで誤って拾ってしまうため、
// 名詞系タグのみを厳密に列挙する。
const NOUN_POS = new Set(['n', 'n-adv', 'n-t', 'n-pref', 'n-suf', 'n-pr']);

// 抽出する語数の上限。種別ごとに設けているのは、無名すぎる語(人名の末端など)で
// 辞書全体が埋まってゲームとして破綻するのを避けるため。値自体はここで調整できる。
const CAPS = {
  noun: 20000,
  place: 150000,
  person: 40000, // 著名人(伝記情報あり)のみ採用するため、上限自体は実質効かない想定
};
const CAP_DEFAULT = Infinity; // company / product / work / group / station など元々件数が少ないものは無制限

// JMdict の field タグ→日本語ラベル。専門用語として「よく使われる(common)」条件を
// 外して幅広い分野から抽出する(医学・化学だけでなく理数・人文・スポーツ・文化まで)。
// 値が無いタグ(field はあるが下記に列挙していないもの)は対象外になる。
const FIELD_LABELS = {
  // 医学・生物医学系
  med:'医学', chem:'化学', biochem:'生化学', pharm:'薬学', anat:'解剖学', physiol:'生理学',
  pathol:'病理学', genet:'遺伝学', dent:'歯学', surg:'外科', embryo:'発生学', vet:'獣医学',
  // 理数・工学系
  math:'数学', geom:'幾何学', stat:'統計学', logic:'論理学', physics:'物理学', astron:'天文学',
  geol:'地学', met:'気象学', min:'鉱物学', mining:'鉱業', cryst:'結晶学', paleo:'古生物学',
  engr:'工学', mech:'機械工学', electr:'電子工学', elec:'電気', telec:'電気通信', comp:'コンピュータ',
  internet:'インターネット', civeng:'土木工学', archit:'建築', motor:'自動車', rail:'鉄道', aviat:'航空',
  // 生物・自然
  biol:'生物学', zool:'動物学', bot:'植物学', ecol:'生態学', ornith:'鳥類学', fish:'魚類学',
  ent:'昆虫学', geogr:'地理学', agric:'農業', gardn:'園芸',
  // 人文・社会
  law:'法律', econ:'経済学', bus:'ビジネス', finc:'金融', stockm:'株式市場', politics:'政治学',
  phil:'哲学', psy:'心理学', psych:'心理学', psyanal:'精神分析学', ling:'言語学', gramm:'文法',
  archeol:'考古学', tradem:'商標', print:'印刷',
  // 宗教
  Buddh:'仏教', Christn:'キリスト教', Shinto:'神道',
  // 文化・芸術・娯楽
  art:'美術', music:'音楽', film:'映画', tv:'テレビ', manga:'漫画', vidg:'ゲーム', photo:'写真',
  audvid:'音響・映像', noh:'能', kabuki:'歌舞伎', cloth:'服飾', food:'料理',
  // スポーツ・遊戯
  sports:'スポーツ', baseb:'野球', sumo:'相撲', golf:'ゴルフ', boxing:'ボクシング', MA:'武道',
  ski:'スキー', horse:'競馬', prowres:'プロレス', figskt:'フィギュアスケート',
  mahj:'麻雀', go:'囲碁', shogi:'将棋', cards:'カードゲーム', hanaf:'花札',
  // その他
  mil:'軍事',
};

// ギリシャ/ローマ/中国/日本の神話に関する field タグ。ゼウス・ヘラクレス等の
// 神話上の人物・神・生物がここから採れる(JMnedictのmyth種別は件数が少ないため補完)。
const MYTHOLOGY_FIELDS = new Set(['grmyth', 'rommyth', 'chmyth', 'jpmyth']);

// JMnedictの種別のうち「個人の名前」を表すもの。この5種は生没年などの伝記情報が
// JMnedict上で確認できる語(=著名人と判定できる語)だけを採用する。
const PERSON_TYPES_REQUIRE_BIO = new Set(['person', 'surname', 'given', 'fem', 'masc', 'unclass']);

const NAME_TYPE_LABEL = {
  place: '地名', organization: '組織名', company: '企業名', product: '製品名',
  work: '作品名', station: '駅名', group: 'グループ名', person: '人名',
  surname: '姓', given: '名', fem: '女性の名', masc: '男性の名', unclass: '固有名詞',
  serv: '固有名詞', obj: '固有名詞', char: 'キャラクター', dei: '神話の神',
  fict: '架空の人物', creat: '架空の生物', myth: '神話', ship: '固有名詞',
  ev: '固有名詞', leg: '伝説上の人物', doc: '固有名詞',
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

// t(tier)は「有名度」の目印。1=著名(都道府県・主要都市・広く知られた人物など)を付けておくと、
// script.js側のAI選手選びで優先的に手として選ばれるようになる(kana.js側の判定には無関係)。
// 通常語は t を省略してよい(その場合ファイル上は無印=tier0として扱われる)。
// d(簡単な日本語の解説。例: りんご→「バラ科の樹木、およびその食用となる果実のこと」)は
// mとは別枠の項目。script.js側はd があればdを、無ければ従来通りmを表示に使う。
function addEntry(out, seenReadings, cap, { w, r, m, t, d }){
  if(!KANA_ONLY.test(r)) return false;
  if(r.length < 2) return false;
  if(seenReadings.has(r)) return false;
  if(out.length >= cap) return false;
  seenReadings.add(r);
  const entry = { w, r, m };
  if(t) entry.t = t;
  if(d) entry.d = d;
  out.push(entry);
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

    // JMdictの「よく使われる(common)」フラグが付いた語は、りんご・机のような
    // 誰でも知っている一般語である。数万〜数十万語の専門用語・固有名詞に埋もれて
    // 出にくくならないよう、この一般名詞は丸ごと tier1(著名優先)にしている。
    addEntry(out, seenReadings, CAPS.noun, {
      w: (kanjiCommon && kanjiCommon.text) || kanaCommon.text,
      r: reading,
      m: `(en) ${gloss.text}`,
      t: 1,
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

// FIELD_LABELS に列挙した分野の専門用語をまとめて抽出する。「よく使われる(common)」
// 条件は外している(専門用語はそもそも一般的な語ではないため)。複数分野にまたがる語は
// 最初に見つかった分野のラベルを使う。意味欄は "[分野] (en) 英語のgloss" の形式。
function extractFieldTerms(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    let label = null;
    for(const s of word.sense){
      for(const f of (s.field || [])){
        if(FIELD_LABELS[f]){ label = FIELD_LABELS[f]; break; }
      }
      if(label) break;
    }
    if(!label) continue;

    const reading = toHiragana(kana.text);
    const gloss = word.sense.flatMap(s => s.gloss || []).find(g => g.lang === 'eng');
    if(!gloss) continue;
    const kanji = word.kanji && word.kanji[0];

    addEntry(out, seenReadings, Infinity, {
      w: (kanji && kanji.text) || kana.text,
      r: reading,
      m: `[${label}] (en) ${gloss.text}`,
    });
  }
  console.log(`専門用語(分野横断): ${out.length}語`);
  return out;
}

function extractMythology(data, seenReadings){
  const out = [];
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const isTarget = word.sense.some(s => (s.field || []).some(f => MYTHOLOGY_FIELDS.has(f)));
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
  console.log(`神話: ${out.length}語`);
  return out;
}

// 生没年などの伝記情報(例: "(1879-1955; ...)")を含む翻訳文を返す。
// 見つからなければ null(=著名人と判定できない)。JMnedictにはそれ以外の
// 著名度指標が無いため、この伝記情報の有無を「著名人らしさ」の判定に使う。
function getBioText(translations){
  for(const t of translations){
    for(const g of t.translation){
      if(/\(\d{3,4}/.test(g.text)) return g.text;
    }
  }
  return null;
}

// 固有名詞の並び優先度(place の上限に収める際、海外由来と推定できる語を優先する)。
function rankTier(cand){
  if(cand.type === 'place' && cand.t === 1) return 0; // 著名な都道府県・主要都市
  if(cand.type === 'place' && !cand.hasKanji) return 1; // 海外由来と推定できる地名
  return 2;
}

function primaryNameType(word){
  const types = new Set();
  for(const t of word.translation) for(const ty of (t.type || [])) types.add(ty);
  for(const t of NAME_TYPE_PRIORITY) if(types.has(t)) return t;
  return null;
}

function extractProperNouns(data, seenReadings, famousPlaceNames){
  const buckets = new Map(); // type -> array of {w,r,hasKanji,type,m,t}
  for(const word of data.words){
    const kana = word.kana && word.kana[0];
    if(!kana) continue;
    const type = primaryNameType(word);
    if(!type) continue;

    // person/surname/given/fem/masc/unclass はJMnedict上ただの名前読み辞書であり、
    // 無名な人物も大量に含まれる。生没年などの伝記情報が確認できる語(=著名人と
    // 判定できる語)だけを採用する。それ以外の種別(地名・組織名・神話上の人物など、
    // 個人の実名ではないもの)はこの条件を課さない。
    // 伝記情報がある場合は、種別ラベルの代わりにその伝記情報自体を意味欄に使う
    // (しりとり中に「誰なのか」がそのまま分かるようにするため)。
    let m = NAME_TYPE_LABEL[type];
    if(PERSON_TYPES_REQUIRE_BIO.has(type)){
      const bio = getBioText(word.translation);
      if(!bio) continue;
      m = `(en) ${bio}`;
    }

    const reading = toHiragana(kana.text);
    if(!KANA_ONLY.test(reading) || reading.length < 2) continue;
    const kanji = word.kanji && word.kanji[0];
    const w = (kanji && kanji.text) || kana.text;
    // 都道府県・主要都市の表記(Wikidataから取得済み)と一致する地名はtier1にし、
    // Wikidataの日本語説明文があればdとして使う。読みはJMnedict側のものをそのまま
    // 使う(Wikidataの地名ラベルは漢字表記のみで読みが分からないため)。
    const isFamousPlace = type === 'place' && famousPlaceNames.has(w);
    const cand = {
      w,
      r: reading,
      hasKanji: !!kanji,
      type,
      m,
      t: isFamousPlace ? 1 : undefined,
      d: isFamousPlace ? famousPlaceNames.get(w) : undefined,
    };
    if(!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push(cand);
  }

  const out = [];
  for(const type of NAME_TYPE_PRIORITY){
    const bucket = buckets.get(type);
    if(!bucket) continue;
    // rankTier: 著名な地名、および(placeについて)海外由来(漢字表記なし)を優先して
    // 上限内に収める。Array#sort は安定ソートなので、同ティア内は元の並び順を保つ。
    bucket.sort((a, b) => rankTier(a) - rankTier(b));
    const cap = CAPS[type] ?? CAP_DEFAULT;
    let added = 0, famousAdded = 0;
    for(const cand of bucket){
      if(added >= cap) break;
      if(addEntry(out, seenReadings, Infinity, { w: cand.w, r: cand.r, m: cand.m, t: cand.t, d: cand.d })){
        added++;
        if(cand.t) famousAdded++;
      }
    }
    if(type === 'place') console.log(`  地名のうちtier1(著名な都道府県・主要都市): ${famousAdded}件`);
  }
  console.log(`固有名詞: ${out.length}語`);
  return out;
}

// Wikidata由来のカテゴリ。directOnly=true は P31 の直接インスタンスのみを対象にする
// (Q95074「架空のキャラクター」は下位クラスが非常に多く、P279*での再帰検索は
//  クエリがタイムアウトしやすいため直接インスタンスのみに絞っている)。
// ビデオゲーム/音楽グループは P31 直接インスタンスだけでも1万〜2万件と非常に多く、
// そのまま1クエリで取得しようとすると応答が巨大になりすぎて途中で壊れた(切れた)
// JSONが返ってくることがあった。minSitelinks(掲載されている言語版ウィキペディアの数)で
// 足切りし、「ある程度知られている」ものに絞ることで応答サイズを抑えている。
const WIKIDATA_CATEGORIES = [
  { qid: 'Q22989102', label: '神話の神', directOnly: false },
  { qid: 'Q24334685', label: '神話・伝説の生物', directOnly: false },
  { qid: 'Q95074', label: '架空のキャラクター', directOnly: true },
  { qid: 'Q7889', label: 'ビデオゲーム', directOnly: true, minSitelinks: 5 },
  { qid: 'Q215380', label: '音楽グループ', directOnly: true, minSitelinks: 5 },
];
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_USER_AGENT = 'shiritori-dojo-fetch-words/1.0 (https://github.com/; educational hobby project)';

// query.wikidata.org は共有の公開エンドポイントで、負荷状況により 502 等の
// HTTPエラーだけでなく、応答が大きすぎて壊れた(途中で切れた)JSONが返って
// くることもあるため、JSON解析の失敗も含めてリトライする。
// GET(URLクエリパラメータ)だと、VALUES句に語をたくさん詰めた大きなクエリで
// エンコード後のURLが1万文字を超えることがあり、Wikidata側のエッジ/CDN層で
// 592msほどの短時間で503(Wikimedia Error)が即座に返ってくる現象を確認した
// (SPARQLエンジン側のタイムアウトではなく、リクエストライン長の制限と見られる)。
// POST(クエリをリクエストボディに入れる)にすることでURL長の制限を回避できる。
async function sparql(query, retries = 4){
  for(let attempt = 0; ; attempt++){
    try{
      const res = await fetch(WIKIDATA_ENDPOINT, {
        method: 'POST',
        headers: {
          'Accept': 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': WIKIDATA_USER_AGENT,
        },
        body: `query=${encodeURIComponent(query)}`,
      });
      if(!res.ok) throw new Error(`Wikidata SPARQL error: ${res.status}`);
      const data = await res.json();
      return data.results.bindings;
    }catch(err){
      if(attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

// 結果件数が数千件を超えるクエリは、1回のレスポンスが巨大になりすぎて途中で
// 切れた(壊れた)JSONが返ってくることがある(sparql()のリトライだけでは直らない、
// 毎回同じ理由で壊れるため)。LIMIT/OFFSET でページ単位に分けて取得することで
// 1回あたりの応答サイズを抑える。ORDER BY を付けると(特にP279*のような再帰パスや
// 大きな結果集合で)ページごとに結果全体をソートし直す必要が生じてクエリ自体が
// タイムアウトしやすくなったため、あえて付けていない。順序が安定しない分、
// ページ境界で稀に重複/欠落が起こり得るが、重複はaddEntryの読み重複チェックで
// 吸収され、欠落も少数語を取りこぼす程度で致命的ではないため許容している。
// 1ページの取得が(sparql()内のリトライを尽くしても)失敗した場合は、そこまでに
// 取得できた分だけを返して打ち切る(1ページの不調でカテゴリ全体を諦めないため)。
async function sparqlPaginated(buildQuery, pageSize = 800){
  const out = [];
  for(let offset = 0; ; offset += pageSize){
    let rows;
    try{
      rows = await sparql(buildQuery(pageSize, offset));
    }catch(err){
      console.warn(`  ページ取得(offset=${offset})が失敗したため、ここまでの${out.length}件で打ち切ります: ${err.message}`);
      break;
    }
    out.push(...rows);
    if(rows.length < pageSize) break;
    await new Promise(r => setTimeout(r, 1500)); // Wikidataへの負荷を抑えるための小休止
  }
  return out;
}

async function fetchWikidataLabels(qid, directOnly, minSitelinks){
  const path = directOnly ? 'wdt:P31' : 'wdt:P31/wdt:P279*';
  const sitelinksClause = minSitelinks
    ? `?item wikibase:sitelinks ?sitelinks . FILTER(?sitelinks >= ${minSitelinks})`
    : '';
  return sparqlPaginated((limit, offset) =>
    `SELECT ?item ?itemLabel WHERE { ?item ${path} wd:${qid} . ${sitelinksClause} ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja') } LIMIT ${limit} OFFSET ${offset}`
  );
}

// Wikidataの「人間(Q5)」は全体で数百万件あり、素朴な P31 検索は必ずタイムアウトする。
// 日本語版ウィキペディアに記事がある(=schema:isPartOf jawiki)ことで対象を絞り込み、
// さらに sitelinks(記事が存在する言語版ウィキペディアの数)で足切りすることで、
// 「広く知られている人物」だけをクエリ側で選別する。MIN_SITELINKS を上げるほど
// 世界的に有名な人物に絞られ、クエリも軽くなる(下げすぎるとタイムアウトしやすい)。
const WIKIDATA_HUMAN_MIN_SITELINKS = 12;
// この件数以上の言語版ウィキペディアに記事がある人物は「世界的に広く知られた偉人」と
// みなし、tier1(著名優先)を付ける。sitelinksをSELECTしておくことで、後段で
// クエリを打ち直さずにそのまま判定に使える。
const WIKIDATA_HUMAN_FAMOUS_SITELINKS = 40;
async function fetchWikidataNotableHumans(){
  return sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel ?sitelinks WHERE {
    ?article schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> .
    ?item wdt:P31 wd:Q5 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_HUMAN_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
}

// 都道府県・日本国内の主要都市(sitelinksで足切り)をWikidataから抽出する。
// JMnedictのplace種別(上限150,000件)は無名な地名も大量に含み、AIの手の中で
// 有名な地名が埋もれてしまうため、確実に著名だと分かる地名を tier1 として
// 別枠で確保しておく。
const WIKIDATA_JAPAN_PLACE_MIN_SITELINKS = 15;
// 都道府県・日本国内の主要都市の「表記(漢字)」だけをWikidataから取得する。
// 日本の地名のWikidata日本語ラベルはほぼ全て漢字表記(例: 東京都、大阪市)であり、
// かな表記が無い(=読みがWikidata側から分からない)ため、ここでは読みの情報源としては
// 使わず、JMnedict側で既に読み付きで抽出済みの地名エントリのうち「この漢字表記に
// 一致するもの」を tier1(著名優先)としてマークするための照合キー集合として使う。
// 戻り値は「表記(漢字) -> Wikidataの日本語説明文(無ければundefined)」のMap。
async function fetchFamousJapanPlaceNames(){
  const prefectures = await sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel WHERE {
    ?item wdt:P31 wd:Q50337 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_JAPAN_PLACE_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
  const cities = await sparqlPaginated((limit, offset) => `SELECT ?item ?itemLabel WHERE {
    ?item wdt:P17 wd:Q17 ; wdt:P31/wdt:P279* wd:Q515 ; wikibase:sitelinks ?sitelinks .
    FILTER(?sitelinks >= ${WIKIDATA_JAPAN_PLACE_MIN_SITELINKS})
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel)='ja')
  } LIMIT ${limit} OFFSET ${offset}`);
  const rows = [...prefectures, ...cities];
  const qids = rows.map(row => row.item.value.split('/').pop());
  const descMap = await fetchWikidataDescriptions(qids);
  const names = new Map();
  for(const row of rows){
    const qid = row.item.value.split('/').pop();
    names.set(row.itemLabel.value, descMap.get(qid));
  }
  console.log(`Wikidata(日本の著名な地名の表記): 都道府県${prefectures.length}件 + 都市${cities.length}件 = ${names.size}件(重複除去後、説明文あり${descMap.size}件)`);
  return names;
}

// 説明文はラベル取得とは別クエリでバッチ取得する(1クエリにまとめるとタイムアウトしやすいため)。
async function fetchWikidataDescriptions(qids){
  const out = new Map();
  const CHUNK = 250;
  for(let i = 0; i < qids.length; i += CHUNK){
    const chunk = qids.slice(i, i + CHUNK);
    const values = chunk.map(q => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?desc WHERE { VALUES ?item { ${values} } ?item schema:description ?desc . FILTER(LANG(?desc)='ja') }`;
    try{
      const rows = await sparql(query);
      for(const row of rows) out.set(row.item.value.split('/').pop(), row.desc.value);
    }catch(err){
      // このチャンクだけ諦める(該当語は種別ラベルにフォールバックするので致命的ではない)。
      console.warn(`  説明文取得チャンク(${i}-${i+chunk.length})が失敗したためスキップします: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800)); // Wikidataへの負荷を抑えるための小休止
  }
  return out;
}

// Wikidata(CC0)から、神・神話上の生物・架空のキャラクターを補完的に抽出する。
// 日本語ラベルが純粋なかな(カタカナ/ひらがな)であるものだけを対象にする
// (漢字表記のみのラベルは読みが分からず、しりとりの手として使えないため)。
// 出典として Wikidata の QID を意味欄の末尾に付記する(README にライセンス表記あり)。
async function extractWikidataBeings(seenReadings){
  const out = [];
  for(const cat of WIKIDATA_CATEGORIES){
    try{
      const rows = await fetchWikidataLabels(cat.qid, cat.directOnly, cat.minSitelinks);
      const seenLocal = new Set();
      const candidates = [];
      for(const row of rows){
        const hira = toHiragana(row.itemLabel.value);
        if(!KANA_ONLY.test(hira) || hira.length < 2) continue;
        if(seenLocal.has(hira)) continue;
        seenLocal.add(hira);
        candidates.push({ w: row.itemLabel.value, r: hira, qid: row.item.value.split('/').pop() });
      }
      const descMap = await fetchWikidataDescriptions(candidates.map(c => c.qid));
      let added = 0;
      for(const c of candidates){
        const m = `${cat.label} [Wikidata:${c.qid}]`;
        if(addEntry(out, seenReadings, Infinity, { w: c.w, r: c.r, m, d: descMap.get(c.qid) })) added++;
      }
      console.log(`Wikidata(${cat.label}): ${added}語(説明文あり ${descMap.size}件)`);
    }catch(err){
      console.warn(`Wikidata取得に失敗しました(${cat.label}): ${err.message} — このカテゴリはスキップします`);
    }
  }
  return out;
}

// 日本語版ウィキペディアに記事を持ち、かつ一定数以上の言語版ウィキペディアでも
// 取り上げられている(=広く知られている)人物をWikidataから抽出する。
// JMnedictのperson/surname等(生没年の記載有無で判定)より遥かに件数・情報量が多い。
// 日本語ラベルが漢字表記のみの人物(日本の歴史上の人物など)は読みが分からず対象外になる
// (README参照)。意味欄にはWikidataの日本語説明文をそのまま使う。
async function extractWikidataHumans(seenReadings){
  try{
    const rows = await fetchWikidataNotableHumans();
    const seenLocal = new Set();
    const candidates = [];
    for(const row of rows){
      const hira = toHiragana(row.itemLabel.value);
      if(!KANA_ONLY.test(hira) || hira.length < 2) continue;
      if(seenLocal.has(hira)) continue;
      seenLocal.add(hira);
      const sitelinks = Number(row.sitelinks.value);
      candidates.push({ w: row.itemLabel.value, r: hira, qid: row.item.value.split('/').pop(), famous: sitelinks >= WIKIDATA_HUMAN_FAMOUS_SITELINKS });
    }
    const descMap = await fetchWikidataDescriptions(candidates.map(c => c.qid));
    const out = [];
    let added = 0, famousAdded = 0;
    for(const c of candidates){
      const m = `著名人 [Wikidata:${c.qid}]`;
      if(addEntry(out, seenReadings, Infinity, { w: c.w, r: c.r, m, d: descMap.get(c.qid), t: c.famous ? 1 : undefined })){
        added++;
        if(c.famous) famousAdded++;
      }
    }
    console.log(`Wikidata(著名人): ${added}語(説明文あり ${descMap.size}件、うちtier1(${WIKIDATA_HUMAN_FAMOUS_SITELINKS}言語版以上) ${famousAdded}件)`);
    return out;
  }catch(err){
    console.warn(`Wikidata(著名人)の取得に失敗しました: ${err.message} — このカテゴリはスキップします`);
    return [];
  }
}

// 都道府県・日本国内の主要都市を tier1(著名優先)として抽出する。
async function fetchFamousJapanPlaceNamesSafe(){
  try{
    return await fetchFamousJapanPlaceNames();
  }catch(err){
    console.warn(`Wikidata(日本の著名な地名の表記)の取得に失敗しました: ${err.message} — 地名のtier1付与はスキップします`);
    return new Map();
  }
}

// JMdict由来のカテゴリ(一般名詞・ことわざ/故事成語・専門用語)には日本語の説明文が無い
// (英語glossの m しか無い)ため、Wikidataで「日本語ラベルが表記(entry.w)と完全一致する
// 項目」を探し、見つかった日本語説明文を d として追加する。
//
// 表記が同じでも別の意味の項目(同名の作品・キャラクター・軍艦・雑誌など)に
// ヒットすることがある。あからさまに無関係と分かるもの(人物/作品/軍艦などの型、
// および説明文が『』年号やによる等の「作品らしいパターン」を含むもの)は
// ENTITY_TYPE_BLOCKLIST / NOISE_DESC_PATTERNS で除外するが、除外しきれず複数候補が
// 残った場合は先頭の1件を採用する(=読みの上での同音異義語として扱う。
// どちらの語義であっても実在する言葉であることに変わりはないため)。
const ENTITY_TYPE_BLOCKLIST = [
  'Q5', 'Q11424', 'Q482994', 'Q134556', 'Q7366', 'Q215380', 'Q7889',
  'Q101352', 'Q202444', 'Q4167410', 'Q486972', 'Q515',
];
const NOISE_DESC_EXACT = new Set(['漢字', 'ひらがな', 'カタカナ']);
const NOISE_DESC_PATTERNS = [
  /『.*』/, /「.*」/, /\d{4}年/, /による/, /作曲/, /作詞/,
  /の登場人物/, /に登場/, /クルアーン/, /曲$/, /小説/, /映画/, /漫画/, /ドラマ/,
  /アルバム/, /シングル/, /楽曲/, /戯曲/, /彫刻/, /絵画/, /艦$/, /駆逐艦/, /軍艦/,
  /の姓/, /の名/, /人名/, /町丁/, /大字/, /地名/, /字$/, /曖昧さ回避/,
  /雑誌/, /タロット/, /ムック/, /散文詩/, /の演目/,
];
function isUsableWikidataDesc(desc){
  if(NOISE_DESC_EXACT.has(desc)) return false;
  return !NOISE_DESC_PATTERNS.some(re => re.test(desc));
}

async function enrichWithWikidataDescriptions(entries, label){
  const targets = entries.filter(e => !e.d);
  if(targets.length === 0) return;
  console.log(`Wikidataとの表記一致で説明文を補完中(${label}): 対象${targets.length}語(数分かかることがあります)`);
  const CHUNK = 200;
  const badTypeValues = ENTITY_TYPE_BLOCKLIST.map(q => `wd:${q}`).join(' ');
  let filled = 0;
  for(let i = 0; i < targets.length; i += CHUNK){
    const chunk = targets.slice(i, i + CHUNK);
    const values = chunk.map(e => `"${e.w.replace(/"/g, '\\"')}"@ja`).join(' ');
    const query = `SELECT ?label ?desc WHERE {
      VALUES ?label { ${values} }
      ?item rdfs:label ?label .
      ?item schema:description ?desc . FILTER(LANG(?desc)='ja')
      FILTER NOT EXISTS { ?item wdt:P31 ?badType . VALUES ?badType { ${badTypeValues} } }
    }`;
    try{
      const rows = await sparql(query);
      const descByLabel = new Map();
      for(const row of rows){
        const l = row.label.value, d = row.desc.value;
        if(!isUsableWikidataDesc(d)) continue;
        if(!descByLabel.has(l)) descByLabel.set(l, d); // 除外しきれず複数残った場合は先頭の1件
      }
      for(const e of chunk){
        const d = descByLabel.get(e.w);
        if(d){ e.d = d; filled++; }
      }
    }catch(err){
      console.warn(`  チャンク(${i}-${i + chunk.length})が失敗したためスキップ: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`  → ${label}: ${filled}語に説明文を追加できました`);
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

  // Wikidataは神話・架空の存在/著名人について日本語の説明文を持つことが多く、
  // JMdict/JMnedictの単純な種別ラベルより情報量が多いため、読みが重複した場合は
  // Wikidata側を優先する(=先に登録する)順序にしている。
  const seenReadings = new Set();
  const nouns = extractNouns(commonData, seenReadings);
  const proverbs = extractProverbsAndYoji(fullData, seenReadings);
  const fieldTerms = extractFieldTerms(fullData, seenReadings);

  // JMdict由来で英語glossしか無い一般名詞・ことわざ/専門用語に、Wikidataとの表記一致で
  // 日本語の簡単な説明文(d)を補完する(例: りんご→「セイヨウリンゴの果実」)。
  // 件数が多いため時間がかかる。
  await enrichWithWikidataDescriptions(nouns, '一般名詞');
  await enrichWithWikidataDescriptions(proverbs, 'ことわざ・故事成語');
  await enrichWithWikidataDescriptions(fieldTerms, '専門用語');

  const out = [
    ...nouns,
    ...proverbs,
    ...fieldTerms,
    ...(await extractWikidataBeings(seenReadings)),
    ...(await extractWikidataHumans(seenReadings)),
    ...extractMythology(fullData, seenReadings),
    ...extractProperNouns(neData, seenReadings, await fetchFamousJapanPlaceNamesSafe()),
  ];

  console.log(`抽出できた語数の合計: ${out.length}`);
  const outPath = path.join(ROOT, 'words-auto.tsv');
  await fs.writeFile(outPath, stringifyTSV(out), 'utf-8');
  console.log(`書き出し完了: ${outPath}`);
}

main().catch(err => { console.error('失敗:', err.message); process.exit(1); });
