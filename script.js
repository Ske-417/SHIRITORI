(function(){
  const chainEl = document.getElementById('chain');
  const inputEl = document.getElementById('wordInput');
  const submitBtn = document.getElementById('submitBtn');
  const medallion = document.getElementById('medallion');
  const medallionLabel = document.getElementById('medallionLabel');
  const userScoreEl = document.getElementById('userScore');
  const aiScoreEl = document.getElementById('aiScore');
  const strengthSelect = document.getElementById('strengthSelect');
  const restartBtn = document.getElementById('restartBtn');
  const toastEl = document.getElementById('toast');
  const wordCountEl = document.getElementById('wordCount');

  let WORDS = [];               // 辞書番(AI)専用の辞書。ユーザーの入力判定には使わない
  let usedReadings = new Set(); // これまでに場に出た「読み」(ユーザー・AI問わず)
  let requiredKana = null;      // null = 最初の一手は自由
  let score = {user:0, ai:0};
  let gameOver = false;
  let busy = true;

  // ---------------- かな処理ユーティリティ ----------------
  const KATA_OFFSET = 0x60;
  function toHiragana(str){
    if(!str) return str;
    return str.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - KATA_OFFSET));
  }
  const VOWEL_MAP = {
    'あ':'あ','か':'あ','さ':'あ','た':'あ','な':'あ','は':'あ','ま':'あ','や':'あ','ら':'あ','わ':'あ','が':'あ','ざ':'あ','だ':'あ','ば':'あ','ぱ':'あ',
    'い':'い','き':'い','し':'い','ち':'い','に':'い','ひ':'い','み':'い','り':'い','ぎ':'い','じ':'い','び':'い','ぴ':'い',
    'う':'う','く':'う','す':'う','つ':'う','ぬ':'う','ふ':'う','む':'う','ゆ':'う','る':'う','ぐ':'う','ず':'う','づ':'う','ぶ':'う','ぷ':'う',
    'え':'え','け':'え','せ':'え','て':'え','ね':'え','へ':'え','め':'え','れ':'え','げ':'え','ぜ':'え','で':'え','べ':'え','ぺ':'え',
    'お':'お','こ':'お','そ':'お','と':'お','の':'お','ほ':'お','も':'お','よ':'お','ろ':'お','を':'お','ご':'お','ぞ':'お','ど':'お','ぼ':'お','ぽ':'お'
  };
  const SMALL_YOON = {'ゃ':'や','ゅ':'ゆ','ょ':'よ','ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お'};

  // 語尾から「次に続くべき音」を求める。「ん」で終わっていれば isN:true (=その場で負け)
  function analyzeEnding(readingRaw){
    const reading = toHiragana(readingRaw || '').trim();
    if(!reading) return {kana:null, isN:false};
    const last = reading[reading.length-1];
    if(last === 'ん') return {kana:null, isN:true};
    if(last === 'ー'){
      const prev = reading[reading.length-2];
      return {kana: VOWEL_MAP[prev] || null, isN:false};
    }
    if(SMALL_YOON[last]) return {kana: SMALL_YOON[last], isN:false};
    return {kana:last, isN:false};
  }
  function startKana(readingRaw){
    const reading = toHiragana(readingRaw||'').trim();
    return reading ? reading[0] : null;
  }

  // ---------------- UI ヘルパー ----------------
  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 2800);
  }
  function updateMedallion(){
    if(gameOver){ medallion.textContent = '終'; medallionLabel.innerHTML = '対局<br>終了'; return; }
    if(!requiredKana){ medallion.textContent = '―'; medallionLabel.innerHTML = '最初の<br>ことばへ'; return; }
    medallion.textContent = requiredKana;
    medallionLabel.innerHTML = 'この音<br>から';
  }
  function updateScore(){ userScoreEl.textContent = score.user; aiScoreEl.textContent = score.ai; }
  function scrollToBottom(){ chainEl.scrollTop = chainEl.scrollHeight; }

  function hankoSVG(pass){
    const color = pass ? 'var(--stamp)' : 'var(--ink-faint)';
    const label = pass ? '合格' : '却下';
    const filterId = 'ink' + Math.random().toString(36).slice(2,8);
    return `<svg viewBox="0 0 100 100" width="100%" height="100%">
      <defs>
        <filter id="${filterId}">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4"/>
        </filter>
      </defs>
      <g filter="url(#${filterId})">
        <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="5"/>
        <circle cx="50" cy="50" r="33" fill="none" stroke="${color}" stroke-width="2"/>
        <text x="50" y="43" text-anchor="middle" font-size="19" fill="${color}" font-family="'Hiragino Mincho ProN','Yu Mincho',serif" font-weight="700">${label[0]}</text>
        <text x="50" y="66" text-anchor="middle" font-size="19" fill="${color}" font-family="'Hiragino Mincho ProN','Yu Mincho',serif" font-weight="700">${label[1]}</text>
      </g>
    </svg>`;
  }
  function markReading(reading, markFirst, markLast){
    const chars = reading.split('');
    return chars.map((c,i) => {
      const isMark = (markFirst && i===0) || (markLast && i===chars.length-1);
      return isMark ? '<span class="mark">'+c+'</span>' : c;
    }).join('');
  }

  function renderCard({word, reading, meaning, by, invalid, reason, requiredWasSet}){
    const emptyHint = document.getElementById('emptyHint');
    if(emptyHint && emptyHint.parentNode) emptyHint.remove();

    const card = document.createElement('div');
    card.className = 'card ' + by + (invalid ? ' invalid' : '');

    const seal = document.createElement('div');
    seal.className = 'seal';
    seal.textContent = invalid ? '?' : (by==='user' ? '客' : '番');
    card.appendChild(seal);

    if(!invalid){
      const wordRow = document.createElement('div');
      wordRow.className = 'word-row';
      const w = document.createElement('div'); w.className = 'word'; w.textContent = word;
      const r = document.createElement('div'); r.className = 'reading';
      r.innerHTML = markReading(reading, !!requiredWasSet, true);
      wordRow.appendChild(w); wordRow.appendChild(r);
      card.appendChild(wordRow);
      if(meaning){ const m = document.createElement('div'); m.className='meaning'; m.textContent = meaning; card.appendChild(m); }
      const stamp = document.createElement('div'); stamp.className = 'hanko'; stamp.innerHTML = hankoSVG(true);
      card.appendChild(stamp);
    }else{
      const w = document.createElement('div'); w.className='word'; w.style.fontSize='16px'; w.textContent = word || '(不明)';
      card.appendChild(w);
      const rs = document.createElement('div'); rs.className='reason'; rs.textContent = reason || '無効です';
      card.appendChild(rs);
      const stamp = document.createElement('div'); stamp.className = 'hanko'; stamp.innerHTML = hankoSVG(false);
      card.appendChild(stamp);
    }
    chainEl.appendChild(card);
    scrollToBottom();
  }
  function renderThinking(by){
    const el = document.createElement('div');
    el.className = 'thinking-card ' + by;
    el.id = 'thinkingCard';
    el.innerHTML = (by==='ai' ? '辞書番、考え中' : '受理中') + '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    chainEl.appendChild(el); scrollToBottom();
  }
  function removeThinking(){ const el = document.getElementById('thinkingCard'); if(el) el.remove(); }
  function renderGameOver(winner, note){
    const el = document.createElement('div');
    el.className = 'gameover';
    const win = winner === 'user';
    el.innerHTML = '<div class="result '+(win?'win':'lose')+'">'+(win?'あなたの勝ち':'辞書番の勝ち')+'</div><p>'+note+'</p>';
    chainEl.appendChild(el); scrollToBottom();
  }

  // ---------------- ゲームロジック ----------------

  // ユーザーの入力は「実在する言葉である」ことを前提として信頼する。
  // 辞書には無くても構わない。ただし読み(かな)を確定させる必要があるので、
  //  1) まず辞書に完全一致する語があれば、その読み・意味を使う(表示が豊かになる)
  //  2) 無ければ、入力そのもの(カタカナはひらがなに変換)をそのまま読みとして扱う
  // これにより「辞書にあるかどうか」はもう合否の条件にならない。
  function resolveUserWord(inputRaw){
    const input = inputRaw.trim();
    if(!input) return null;
    const hira = toHiragana(input);

    const dictHit = WORDS.find(e => e.w === input || e.r === input || e.r === hira);
    if(dictHit){
      return { word: dictHit.w, reading: dictHit.r, meaning: dictHit.m };
    }
    // 辞書外でも、純粋なかなであれば読みとしてそのまま信頼する
    if(/^[ぁ-んゔー]+$/.test(hira)){
      return { word: input, reading: hira, meaning: null };
    }
    return null; // 漢字表記かつ辞書に無く、読みが特定できない
  }

  function candidatesFor(kana){
    const out = [];
    WORDS.forEach((e,i) => { if(!usedReadings.has(e.r) && startKana(e.r) === kana) out.push(i); });
    return out;
  }

  function pickAiMove(kana, strength){
    const pool = candidatesFor(kana);
    if(pool.length === 0) return null;

    const scored = pool.map(i => {
      const e = WORDS[i];
      const end = analyzeEnding(e.r);
      const opponentOptions = end.isN ? -1 : candidatesFor(end.kana).filter(j => j !== i).length;
      return {e, isN: end.isN, opponentOptions};
    });

    const safe = scored.filter(s => !s.isN);
    const usable = safe.length ? safe : scored; // 安全な手が無ければ「ん」で終わる手を仕方なく選ぶ(=辞書番の自滅)

    if(strength === 'easy'){
      return usable[Math.floor(Math.random()*usable.length)];
    }
    if(strength === 'normal'){
      usable.sort((a,b) => a.opponentOptions - b.opponentOptions);
      const mid = usable.slice(0, Math.max(1, Math.ceil(usable.length*0.6)));
      return mid[Math.floor(Math.random()*mid.length)];
    }
    // hard: 相手の選択肢が一番少なくなる(=詰ませやすい)手を優先
    usable.sort((a,b) => a.opponentOptions - b.opponentOptions);
    const best = usable.filter(s => s.opponentOptions === usable[0].opponentOptions);
    return best[Math.floor(Math.random()*best.length)];
  }

  function setBusy(v){ busy = v; inputEl.disabled = v || gameOver; submitBtn.disabled = v || gameOver; }

  async function handleSubmit(){
    if(busy || gameOver) return;
    const val = inputEl.value.trim();
    if(!val) return;
    inputEl.value = '';
    setBusy(true);
    renderThinking('user');
    await new Promise(r => setTimeout(r, 200));
    removeThinking();

    const resolved = resolveUserWord(val);
    if(!resolved){
      renderCard({word: val, invalid:true, reason:'読みが特定できません。ひらがな/カタカナで入力してください', by:'user'});
      setBusy(false); return;
    }
    if(requiredKana && startKana(resolved.reading) !== requiredKana){
      renderCard({word: resolved.word, invalid:true, reason:'「'+requiredKana+'」から始まっていません', by:'user'});
      setBusy(false); return;
    }
    if(usedReadings.has(resolved.reading)){
      renderCard({word: resolved.word, invalid:true, reason:'その言葉はすでに使われています', by:'user'});
      setBusy(false); return;
    }

    usedReadings.add(resolved.reading);
    score.user++; updateScore();
    renderCard({word: resolved.word, reading: resolved.reading, meaning: resolved.meaning, by:'user', requiredWasSet: !!requiredKana});

    // ユーザーの言葉が「ん」で終わっていれば、ここで即負け
    const ending = analyzeEnding(resolved.reading);
    if(ending.isN){
      gameOver = true; updateMedallion();
      renderGameOver('ai', 'あなたの言葉の読みが「ん」で終わりました。');
      setBusy(true); return;
    }
    requiredKana = ending.kana;
    updateMedallion();

    renderThinking('ai');
    await new Promise(r => setTimeout(r, 450));
    removeThinking();

    const move = pickAiMove(requiredKana, strengthSelect.value);
    if(!move){
      renderGameOver('user', '辞書番の持ち駒(「'+requiredKana+'」から始まる言葉)が尽きました。');
      gameOver = true; updateMedallion(); setBusy(true); return;
    }
    usedReadings.add(move.e.r);
    score.ai++; updateScore();
    renderCard({word: move.e.w, reading: move.e.r, meaning: move.e.m, by:'ai', requiredWasSet:true});

    // 辞書番の言葉が「ん」で終わっていれば、辞書番の即負け
    if(move.isN){
      gameOver = true; updateMedallion();
      renderGameOver('user', '辞書番が読みが「ん」で終わる言葉を選ばざるを得ませんでした。');
      setBusy(true); return;
    }
    const aiEnding = analyzeEnding(move.e.r);
    requiredKana = aiEnding.kana;
    updateMedallion();
    setBusy(false);
    inputEl.focus();
  }

  function restart(){
    usedReadings = new Set(); requiredKana = null; score = {user:0, ai:0}; gameOver = false;
    updateScore(); updateMedallion();
    chainEl.innerHTML = '<div class="empty-hint" id="emptyHint"><div class="kanban-mini">— 対局開始 —</div>ひらがな・カタカナで、ことばを入力してください。<br>読みが「ん」で終わったら、その場で負けです。</div>';
    setBusy(false);
    inputEl.focus();
  }

  async function init(){
    try{
      const res = await fetch('words.json');
      WORDS = await res.json();
    }catch(e){
      WORDS = [];
      showToast('words.json の読み込みに失敗しました(ローカルサーバー経由で開いてください)');
    }
    wordCountEl.textContent = WORDS.length;
    updateScore(); updateMedallion();
    setBusy(false);
  }

  submitBtn.addEventListener('click', handleSubmit);
  inputEl.addEventListener('keydown', e => { if(e.key === 'Enter') handleSubmit(); });
  restartBtn.addEventListener('click', restart);

  init();
})();
