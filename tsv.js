// words-core.tsv / words-auto.tsv 用の簡易TSVユーティリティ。
// フィールド(w,r,m,t,d)にタブ・改行が含まれることは無い想定のため、
// CSVのような引用符処理は行わず、単純な split('\t') で読み書きする。
const COLUMNS = ['w', 'r', 'm', 't', 'd'];

function escapeCell(v){
  if(v === undefined || v === null) return '';
  return String(v).replace(/[\t\r\n]/g, ' ');
}

// 単語オブジェクトの配列 -> TSVテキスト(1行目はヘッダー)。
export function stringifyTSV(rows){
  const lines = [COLUMNS.join('\t')];
  for(const row of rows){
    lines.push(COLUMNS.map(c => escapeCell(row[c])).join('\t'));
  }
  return lines.join('\n') + '\n';
}

// TSVテキスト -> 単語オブジェクトの配列。空欄の列は省略する
// (t は無ければ tier0 扱い、d は無ければ m にフォールバックする既存の挙動と合わせるため)。
export function parseTSV(text){
  const lines = text.split('\n');
  if(lines.length && lines[lines.length - 1] === '') lines.pop();
  if(lines.length === 0) return [];
  const header = lines[0].split('\t');
  const out = [];
  for(let i = 1; i < lines.length; i++){
    const line = lines[i];
    if(line === '') continue;
    const cells = line.split('\t');
    const obj = {};
    for(let j = 0; j < header.length; j++){
      const val = cells[j];
      if(val === undefined || val === '') continue;
      obj[header[j]] = header[j] === 't' ? Number(val) : val;
    }
    out.push(obj);
  }
  return out;
}
