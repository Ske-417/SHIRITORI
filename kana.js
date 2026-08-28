// かな処理ユーティリティ。script.js と test/kana.test.mjs の両方から読み込む。
const KATA_OFFSET = 0x60;

export function toHiragana(str){
  if(!str) return str;
  return str.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - KATA_OFFSET));
}

export const VOWEL_MAP = {
  'あ':'あ','か':'あ','さ':'あ','た':'あ','な':'あ','は':'あ','ま':'あ','や':'あ','ら':'あ','わ':'あ','が':'あ','ざ':'あ','だ':'あ','ば':'あ','ぱ':'あ',
  'い':'い','き':'い','し':'い','ち':'い','に':'い','ひ':'い','み':'い','り':'い','ぎ':'い','じ':'い','び':'い','ぴ':'い',
  'う':'う','く':'う','す':'う','つ':'う','ぬ':'う','ふ':'う','む':'う','ゆ':'う','る':'う','ぐ':'う','ず':'う','づ':'う','ぶ':'う','ぷ':'う',
  'え':'え','け':'え','せ':'え','て':'え','ね':'え','へ':'え','め':'え','れ':'え','げ':'え','ぜ':'え','で':'え','べ':'え','ぺ':'え',
  'お':'お','こ':'お','そ':'お','と':'お','の':'お','ほ':'お','も':'お','よ':'お','ろ':'お','を':'お','ご':'お','ぞ':'お','ど':'お','ぼ':'お','ぽ':'お',
  'ゐ':'い', 'ゑ':'え' // 歴史的仮名遣い(ゐ=wi, ゑ=we)。固有名詞の読みに稀に出現する
};

export const SMALL_YOON = {'ゃ':'や','ゅ':'ゆ','ょ':'よ','ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お'};

// 語尾から「次に続くべき音」を求める。「ん」で終わっていれば isN:true (=その場で負け)
export function analyzeEnding(readingRaw){
  const reading = toHiragana(readingRaw || '').trim();
  if(!reading) return {kana:null, isN:false};
  const last = reading[reading.length-1];
  if(last === 'ん') return {kana:null, isN:true};
  if(last === 'ー'){
    // 「てぃー」「しょー」のように、長音の直前が拗音・小さい母音(ぁぃぅぇぉ)のことがある。
    // VOWEL_MAP は通常サイズのかなしか持たないため、先に SMALL_YOON で正規化してから引く。
    let prev = reading[reading.length-2];
    if(SMALL_YOON[prev]) prev = SMALL_YOON[prev];
    return {kana: VOWEL_MAP[prev] || null, isN:false};
  }
  if(SMALL_YOON[last]) return {kana: SMALL_YOON[last], isN:false};
  return {kana:last, isN:false};
}

export function startKana(readingRaw){
  const reading = toHiragana(readingRaw||'').trim();
  return reading ? reading[0] : null;
}

// 濁点・半濁点付きの音から、それを外した清音を返す(該当なしは undefined)。
export const DAKUTEN_BASE = {
  'が':'か','ぎ':'き','ぐ':'く','げ':'け','ご':'こ',
  'ざ':'さ','じ':'し','ず':'す','ぜ':'せ','ぞ':'そ',
  'だ':'た','ぢ':'ち','づ':'つ','で':'て','ど':'と',
  'ば':'は','び':'ひ','ぶ':'ふ','べ':'へ','ぼ':'ほ',
  'ぱ':'は','ぴ':'ひ','ぷ':'ふ','ぺ':'へ','ぽ':'ほ',
  'ゔ':'う',
};

// 歴史的仮名遣い→現代仮名遣い(該当なしは undefined)。
export const HISTORICAL_KANA_MODERN = { 'を':'お', 'ゐ':'い', 'ゑ':'え' };

// 直前の語の語尾の音(kana)から、次の語が始まってよい音の一覧を返す。
// 通常は [kana] の1つだけだが、このアプリの緩和ルールとして:
//  - 濁点・半濁点付きの音で終わった場合、清音から始める応答も許容する(例: 「ば」→「ば」「は」)
//  - 歴史的仮名遣い(を/ゐ/ゑ)で終わった場合、現代仮名遣いから始める応答も許容する(例: 「を」→「を」「お」)
// を認める。どちらも一方向のみ(清音や現代仮名遣いで終わった場合に濁音/historicalを
// 追加で許すことはしない)。
export function acceptableStartKana(kana){
  if(!kana) return [];
  const set = new Set([kana]);
  if(DAKUTEN_BASE[kana]) set.add(DAKUTEN_BASE[kana]);
  if(HISTORICAL_KANA_MODERN[kana]) set.add(HISTORICAL_KANA_MODERN[kana]);
  return [...set];
}
