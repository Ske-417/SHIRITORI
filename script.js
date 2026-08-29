import { toHiragana, analyzeEnding, startKana, acceptableStartKana } from './kana.js';

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
  const timerFill = document.getElementById('timerFill');
  const timerLabel = document.getElementById('timerLabel');
  const timerToggle = document.getElementById('timerToggle');

  let WORDS = [];               // 辞書番(AI)専用の辞書。ユーザーの入力判定には使わない
  let usedReadings = new Set(); // これまでに場に出た「読み」(ユーザー・AI問わず)
  let requiredKana = null;      // null = 最初の一手は自由
  let score = {user:0, ai:0};
  let gameOver = false;
  let busy = true;

  // ---------------- 持ち時間(強さに関わらず一律) ----------------
  const TURN_TIME_LIMIT = 60; // 秒
  let turnInterval = null;
  let turnRemaining = TURN_TIME_LIMIT;
  function clearTurnTimer(){
    if(turnInterval){ clearInterval(turnInterval); turnInterval = null; }
    timerFill.style.width = '100%';
    timerFill.classList.remove('urgent');
    timerLabel.textContent = timerToggle.checked ? (TURN_TIME_LIMIT + '秒') : 'OFF';
    timerLabel.classList.remove('urgent');
  }
  function startTurnTimer(){
    clearTurnTimer();
    if(!timerToggle.checked) return; // OFFのときは計測しない(無制限)
    turnRemaining = TURN_TIME_LIMIT;
    turnInterval = setInterval(() => {
      turnRemaining--;
      if(turnRemaining <= 0){
        clearInterval(turnInterval); turnInterval = null;
        timerFill.style.width = '0%';
        timerLabel.textContent = '0秒';
        handleTimeout();
        return;
      }
      const pct = Math.max(0, (turnRemaining / TURN_TIME_LIMIT) * 100);
      timerFill.style.width = pct + '%';
      timerLabel.textContent = turnRemaining + '秒';
      const urgent = turnRemaining <= 10;
      timerFill.classList.toggle('urgent', urgent);
      timerLabel.classList.toggle('urgent', urgent);
    }, 1000);
  }

  // ---------------- UI ヘルパー ----------------
  function showToast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 2800);
  }
  function updateMedallion(){
    medallion.classList.remove('multi');
    if(gameOver){ medallion.textContent = '終'; medallionLabel.innerHTML = '対局<br>終了'; return; }
    if(!requiredKana){ medallion.textContent = '―'; medallionLabel.innerHTML = '最初の<br>ことばへ'; return; }
    const opts = acceptableStartKana(requiredKana);
    if(opts.length > 1){
      medallion.textContent = opts.join('/');
      medallion.classList.add('multi');
    }else{
      medallion.textContent = requiredKana;
    }
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

  // 語彙が数万語規模になったため、「かな→その音で始まる語」の索引を読み込み時に一度だけ作り、
  // 候補列挙のたびに全語をなめないようにする。
  let wordsByKana = new Map();
  function buildWordIndex(){
    wordsByKana = new Map();
    for(const e of WORDS){
      const k = startKana(e.r);
      if(!k) continue;
      if(!wordsByKana.has(k)) wordsByKana.set(k, []);
      wordsByKana.get(k).push(e);
    }
  }
  // kana から始まる語に加え、濁点/半濁点を外した清音や歴史的仮名遣いの現代読みで
  // 始まる語も候補に含める(acceptableStartKana、このアプリの緩和ルール)。
  function candidatesFor(kana, used){
    const out = [];
    for(const k of acceptableStartKana(kana)){
      for(const e of (wordsByKana.get(k) || [])){
        if(!used.has(e.r)) out.push(e);
      }
    }
    return out;
  }
  // 使用済みを考慮しない、おおよその「かな→語数」。深い先読みの枝刈り(有望な候補の絞り込み)にのみ使う概算値。
  function kanaSizeApprox(kana){
    if(!kana) return 0;
    let sum = 0;
    for(const k of acceptableStartKana(kana)) sum += (wordsByKana.get(k) || []).length;
    return sum;
  }

  // 制限時間切れの際、「ちなみにこんな言葉があった」という一例を示すための候補探し。
  // requiredKana が無い(最初の一手)場合は未使用の語からランダムに1つ選ぶ。
  function pickHintWord(kana){
    const pool = kana ? candidatesFor(kana, usedReadings) : WORDS.filter(e => !usedReadings.has(e.r));
    if(pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const LOOKAHEAD_BRANCH_CAP = 12; // 2手目以降で深掘りする候補数の上限(枝刈り)
  const HARD_OUTER_CAP = 50;       // 一手目候補のうち、深く読むのは有望な上位何件までか
  const HARD_LOOKAHEAD_DEPTH = 2;  // 0=1手先読み(従来通り) 1=2手先読み 2=3手先読み

  // kana から始まる語を選ぶ番の人にとって「その後どれだけ選択肢が少ないか」を depth 手先まで評価する。
  // depth<=0 ならその場の候補数をそのまま返す(=1手先読み相当)。depth>0 では、
  // お互いが同じ基準(相手の選択肢を最も減らす手)で最適に打ち続けたと仮定して深く評価する。
  // 候補数が多い場合は kanaSizeApprox の概算値で有望な候補だけに絞ってから再帰する(全探索は重すぎるため)。
  function minimaxOptions(kana, used, depth){
    const pool = candidatesFor(kana, used);
    if(pool.length === 0 || depth <= 0) return pool.length;

    let candidates = pool;
    if(candidates.length > LOOKAHEAD_BRANCH_CAP){
      candidates = [...pool].sort((a,b) => {
        const ea = analyzeEnding(a.r), eb = analyzeEnding(b.r);
        return kanaSizeApprox(ea.isN ? null : ea.kana) - kanaSizeApprox(eb.isN ? null : eb.kana);
      }).slice(0, LOOKAHEAD_BRANCH_CAP);
    }

    let best = Infinity;
    for(const e of candidates){
      const end = analyzeEnding(e.r);
      let val;
      if(end.isN){
        val = 0; // 相手を「ん」で終わる語に追い込めれば、それ以上ないくらい良い手
      }else{
        used.add(e.r);
        val = minimaxOptions(end.kana, used, depth - 1);
        used.delete(e.r);
      }
      if(val < best) best = val;
      if(best === 0) break;
    }
    return best;
  }

  function pickAiMove(kana, strength){
    const pool = candidatesFor(kana, usedReadings);
    if(pool.length === 0) return null;

    // 語彙が数万〜十万語規模になったため、ここでは概算値(kanaSizeApprox、使用済みを考慮しない
    // O(1)の目安)で高速に見積もる。正確な値が必要な「めちゃ強い」の最終決定は、後段で
    // 有望な上位候補だけに絞ってから使用済みを考慮した正確な探索(minimaxOptions)を行う。
    const scored = pool.map(e => {
      const end = analyzeEnding(e.r);
      const approxOptions = end.isN ? -1 : kanaSizeApprox(end.kana);
      return {e, end, isN: end.isN, approxOptions};
    });

    const safe = scored.filter(s => !s.isN);
    const usable = safe.length ? safe : scored; // 安全な手が無ければ「ん」で終わる手を仕方なく選ぶ(=辞書番の自滅)

    if(strength === 'easy'){
      return usable[Math.floor(Math.random()*usable.length)];
    }
    if(strength === 'normal'){
      usable.sort((a,b) => a.approxOptions - b.approxOptions);
      const mid = usable.slice(0, Math.max(1, Math.ceil(usable.length*0.6)));
      return mid[Math.floor(Math.random()*mid.length)];
    }

    // hard: まず概算値(kanaSizeApprox)で有望な候補に絞り込み、その上位だけを
    // 使用済みを考慮した正確な探索で2〜3手先まで深掘りして最終決定する
    // (合法手すべてを正確に数えてから深く読むと、語彙が大きいときに重すぎるため)。
    usable.sort((a,b) => a.approxOptions - b.approxOptions);
    const deepPool = usable.slice(0, HARD_OUTER_CAP);
    for(const s of deepPool){
      if(s.isN){ s.deepScore = 0; continue; }
      usedReadings.add(s.e.r);
      s.deepScore = minimaxOptions(s.end.kana, usedReadings, HARD_LOOKAHEAD_DEPTH);
      usedReadings.delete(s.e.r);
    }
    deepPool.sort((a,b) => a.deepScore - b.deepScore);
    const best = deepPool.filter(s => s.deepScore === deepPool[0].deepScore);
    return best[Math.floor(Math.random()*best.length)];
  }

  function setBusy(v){
    busy = v;
    inputEl.disabled = v || gameOver;
    submitBtn.disabled = v || gameOver;
    // あなたの手番(=busyでもgameOverでもない)のときだけ持ち時間を計測する。
    if(v || gameOver) clearTurnTimer();
    else startTurnTimer();
  }

  // 制限時間(強さに関わらず一律 TURN_TIME_LIMIT 秒)以内に入力できなかった場合の即負け。
  function handleTimeout(){
    if(busy || gameOver) return;
    gameOver = true;
    const hint = pickHintWord(requiredKana);
    let note = '制限時間('+TURN_TIME_LIMIT+'秒)以内に言葉を入力できませんでした。';
    if(hint){
      const shown = hint.w === hint.r ? hint.w : (hint.w+'('+hint.r+')');
      note += '<br><span class="hint">ちなみに「'+shown+'」という言葉がありました。</span>';
    }
    updateMedallion();
    renderGameOver('ai', note);
    setBusy(true);
  }

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
    if(requiredKana && !acceptableStartKana(requiredKana).includes(startKana(resolved.reading))){
      const opts = acceptableStartKana(requiredKana).map(k => '「'+k+'」').join('か');
      renderCard({word: resolved.word, invalid:true, reason: opts+'から始まっていません', by:'user'});
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
      const opts = acceptableStartKana(requiredKana).map(k => '「'+k+'」').join('か');
      renderGameOver('user', '辞書番の持ち駒('+opts+'から始まる言葉)が尽きました。');
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
    requiredKana = move.end.kana;
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

  // words-core.json(手作業・日本語の意味つき)と words-auto.json(自動取得分)を
  // 両方読み込み、読み(reading)が重複する場合は words-core.json を優先してマージする。
  // words-auto.json は無くても(未生成でも)動くようにする。
  async function loadWords(){
    const [coreRes, autoRes] = await Promise.allSettled([
      fetch('words-core.json'),
      fetch('words-auto.json'),
    ]);
    const core = coreRes.status === 'fulfilled' && coreRes.value.ok ? await coreRes.value.json() : [];
    const auto = autoRes.status === 'fulfilled' && autoRes.value.ok ? await autoRes.value.json() : [];

    const seen = new Set();
    const merged = [];
    for(const e of core){ if(!seen.has(e.r)){ seen.add(e.r); merged.push(e); } }
    for(const e of auto){ if(!seen.has(e.r)){ seen.add(e.r); merged.push(e); } }

    if(core.length === 0 && auto.length === 0) throw new Error('no words loaded');
    return merged;
  }

  async function init(){
    try{
      WORDS = await loadWords();
    }catch(e){
      WORDS = [];
      showToast('辞書データの読み込みに失敗しました(ローカルサーバー経由で開いてください)');
    }
    buildWordIndex();
    wordCountEl.textContent = WORDS.length.toLocaleString('ja-JP');
    updateScore(); updateMedallion();
    setBusy(false);
  }

  submitBtn.addEventListener('click', handleSubmit);
  // IME変換確定のEnterでも submit してしまわないよう、変換中(isComposing/keyCode 229)は無視する。
  // これにより「変換確定のEnter」と「送信のEnter」が別の操作として扱われる。
  inputEl.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    if(e.isComposing || e.keyCode === 229) return;
    handleSubmit();
  });
  restartBtn.addEventListener('click', restart);
  // ON/OFFの切り替えを即座に反映する(対局中でも切り替え可能)。
  // OFFにした瞬間は計測をやめ、ONに戻した瞬間はあなたの手番であれば新たに計測を始める。
  timerToggle.addEventListener('change', () => {
    if(timerToggle.checked){
      if(!busy && !gameOver) startTurnTimer();
    }else{
      clearTurnTimer();
    }
  });

  init();
})();
