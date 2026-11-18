/* 神经网络训练营 —— 基于 MLP 知识的闯关游戏，纯前端无依赖 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (v, d) => {
    d = d === undefined ? 3 : d;
    if (!isFinite(v)) return '—';
    if (Math.abs(v) < 1e-4 && v !== 0) return v.toExponential(1);
    return v.toFixed(d);
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const LEVELS = [
    {
      name: '前向传播接力', kicker: 'LEVEL 1 · 前向传播', taskCount: 2,
      know: '输入 → 隐藏 → 输出，逐层计算 z = W·a + b，再经过激活函数得到本层输出。',
      goal: '按正确顺序点亮网络中的 5 个节点，并选出输出层的预测值。',
      pass: '完成 2 个样本的节点接力与答案选择。',
      start: startL1, render: renderL1, resetTask: resetL1
    },
    {
      name: '权重调参画分界线', kicker: 'LEVEL 2 · 权重与偏置', taskCount: 1,
      know: '单个神经元的判定条件是 w₁x + w₂y + b = 0，权重决定方向，偏置决定位置。',
      goal: '拖动滑块调整 w₁、w₂、b，让 6 个点全部被正确分到两侧。',
      pass: '6 个点全部分类正确，且最小间隔大于 0.12。',
      start: startL2, render: renderL2
    },
    {
      name: '学习率选择挑战', kicker: 'LEVEL 3 · 学习率', taskCount: 3,
      know: '更新规则 w ← w − η·∂L/∂w。η 太小下降慢，太大可能越过最低点甚至发散。',
      goal: '为每轮选择合适的学习率，让损失一次性降到 0.05 以下。',
      pass: '连续完成 3 轮学习率选择。',
      start: startL3, render: renderL3
    },
    {
      name: '梯度方向侦探', kicker: 'LEVEL 4 · 梯度', taskCount: 3,
      know: '梯度指向损失上升最快的方向，训练要沿它的反方向（负梯度）移动。',
      goal: '在等高线图上，选出当前位置损失下降最快的方向。',
      pass: '连续 3 轮选对负梯度方向。',
      start: startL4, render: renderL4
    },
    {
      name: '终极训练挑战', kicker: 'LEVEL 5 · 完整训练', taskCount: 1,
      know: '真实训练一个 MLP：网络容量、学习率、训练轮数共同决定最终效果。',
      goal: '配置隐藏神经元、学习率和训练轮数，让准确率达到 90% 以上。',
      pass: '训练结束后准确率 ≥ 90%。',
      start: startL5, render: renderL5
    }
  ];

  const state = {
    level: 0, score: 0, task: 0, taskRetries: 0, levelRetries: 0,
    stars: [0, 0, 0, 0, 0], levelPoints: [0, 0, 0, 0, 0], lv: {}
  };

  /* ==================== 弹层与流程 ==================== */

  function showModal(html, handlers) {
    $('modal').innerHTML = html;
    $('overlay').classList.remove('hidden');
    Object.keys(handlers || {}).forEach((id) => {
      const b = $(id);
      if (b) b.onclick = () => { closeModal(); handlers[id](); };
    });
  }
  function closeModal() { $('overlay').classList.add('hidden'); $('modal').innerHTML = ''; }

  function updateHUD() {
    const stars = state.stars.reduce((a, b) => a + b, 0);
    $('hudLevel').textContent = (state.level + 1) + ' / 5';
    $('hudName').textContent = LEVELS[state.level].name;
    $('hudScore').textContent = state.score;
    $('hudStars').textContent = '★'.repeat(stars) + '☆'.repeat(15 - stars);
    $('progressFill').style.width = (state.level / 5 * 100) + '%';
    $('progressDots').innerHTML = Array.from({ length: 5 }, (_, i) =>
      '<i class="' + (i < state.level ? 'done' : (i === state.level ? 'current' : '')) + '"></i>').join('');
  }

  function stopTimer() {
    if (state.lv && state.lv.timer) { clearInterval(state.lv.timer); state.lv.timer = null; }
  }

  function startGame() {
    stopTimer(); closeModal();
    state.level = 0; state.score = 0; state.stars = [0, 0, 0, 0, 0];
    state.levelPoints = [0, 0, 0, 0, 0];
    $('screen-start').classList.remove('active');
    $('screen-game').classList.add('active');
    updateHUD();
    showLevelIntro();
  }

  function showLevelIntro() {
    const L = LEVELS[state.level];
    showModal(
      '<div class="modal-kicker">' + L.kicker + '</div>' +
      '<h2>' + L.name + '</h2>' +
      '<p>' + L.know + '</p>' +
      '<div class="modal-list">' +
      '<div><b>目标</b><span>' + L.goal + '</span></div>' +
      '<div><b>通关</b><span>' + L.pass + '</span></div>' +
      '<div><b>提示</b><span>答错可以重试，但会影响星级和得分。</span></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn btn-quiet" id="modalAlt">返回首页</button>' +
      '<button class="btn btn-primary" id="modalNext">开始本关 →</button></div>',
      { modalNext: beginLevel, modalAlt: backHome }
    );
  }

  function backHome() {
    stopTimer(); closeModal();
    $('screen-game').classList.remove('active');
    $('screen-start').classList.add('active');
  }

  function beginLevel() {
    closeModal();
    state.task = 0; state.taskRetries = 0; state.levelRetries = 0; state.lv = {};
    updateHUD();
    LEVELS[state.level].start();
  }

  function renderTask() { LEVELS[state.level].render(); }

  function taskResult(ok, title, message, points, onRetry) {
    if (ok) {
      state.score += points;
      state.levelPoints[state.level] += points;
    } else {
      state.taskRetries++;
      state.levelRetries++;
      if (LEVELS[state.level].resetTask) LEVELS[state.level].resetTask();
    }
    updateHUD();
    const last = state.task + 1 >= LEVELS[state.level].taskCount;
    const label = ok ? (last ? '查看本关成绩 →' : '下一题 →') : '再试一次';
    showModal(
      '<div class="modal-kicker">' + (ok ? '任务完成' : '再想一想') + '</div>' +
      '<h2>' + title + '</h2>' +
      '<div class="' + (ok ? 'feedback-good' : 'feedback-bad') + '">' + message + '</div>' +
      (ok ? '<div class="score-pop">本题得分 <strong>+' + points + '</strong></div>' :
        '<p style="margin-top:12px">本次重试已记录，普通重试仍可获得部分分数。</p>') +
      '<div class="modal-actions"><button class="btn ' + (ok ? 'btn-primary' : 'btn-green') + '" id="modalNext">' + label + '</button></div>',
      {
        modalNext: () => {
          if (ok) nextTask();
          else if (onRetry) onRetry();
          else renderTask();
        }
      }
    );
  }

  function nextTask() {
    state.task++;
    state.taskRetries = 0;
    const L = LEVELS[state.level];
    if (L.resetTask) L.resetTask();
    if (state.task >= L.taskCount) completeLevel();
    else renderTask();
  }

  function completeLevel() {
    const stars = state.levelRetries === 0 ? 3 : (state.levelRetries <= 2 ? 2 : 1);
    state.stars[state.level] = stars;
    const bonus = stars * 20;
    state.score += bonus;
    state.levelPoints[state.level] += bonus;
    const last = state.level === LEVELS.length - 1;
    updateHUD();
    showModal(
      '<div class="modal-kicker">关卡通过</div>' +
      '<h2>' + LEVELS[state.level].name + ' 完成</h2>' +
      '<div class="big-stars">' + '★'.repeat(stars) + '☆'.repeat(3 - stars) + '</div>' +
      '<p style="text-align:center">本关累计得分 <strong>' + state.levelPoints[state.level] + '</strong>（含星级奖励 +' + bonus + '）</p>' +
      '<div class="modal-actions"><button class="btn btn-primary" id="modalNext">' + (last ? '查看总成绩 →' : '进入下一关 →') + '</button></div>',
      { modalNext: last ? showFinal : () => { stopTimer(); state.level++; showLevelIntro(); } }
    );
  }

  function showFinal() {
    updateHUD();
    const totalStars = state.stars.reduce((a, b) => a + b, 0);
    const medal = totalStars >= 13 ? '金牌训练师' : (totalStars >= 9 ? '银牌训练师' : '铜牌训练师');
    let rows = '';
    LEVELS.forEach((L, i) => {
      rows += '<tr><td>' + (i + 1) + '. ' + L.name + '</td><td>' + '★'.repeat(state.stars[i]) + '☆'.repeat(3 - state.stars[i]) +
        '</td><td>' + state.levelPoints[i] + '</td></tr>';
    });
    showModal(
      '<div class="modal-kicker">挑战完成</div>' +
      '<h2>训练营结算</h2>' +
      '<div class="medal">' + medal + '</div>' +
      '<div class="score-pop">总分 <strong>' + state.score + '</strong> · 星级 <strong>' + totalStars + ' / 15</strong></div>' +
      '<table class="result-table"><thead><tr><th>关卡</th><th>星级</th><th>得分</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p>你已掌握：前向传播顺序、权重与决策边界、学习率选择、梯度方向，以及如何完整训练一个 MLP。</p>' +
      '<div class="modal-actions"><button class="btn btn-quiet" id="modalAlt">返回首页</button>' +
      '<button class="btn btn-primary" id="modalNext">再玩一次</button></div>',
      { modalNext: startGame, modalAlt: backHome }
    );
  }

  function levelHead(title, meta) {
    const L = LEVELS[state.level];
    return '<div class="level-head"><div class="kicker">' + L.kicker + '</div><h2>' + L.name + '</h2><p>' + L.goal + '</p></div>' +
      '<div class="level-card"><div class="task-bar"><span class="task-title">' + title + '</span>' +
      '<span class="task-meta">' + meta + '</span></div>';
  }

  /* ==================== 关卡 1：前向传播接力 ==================== */

  const W1 = [[0.8, -0.5], [-0.4, 0.9]], B1 = [0.1, -0.2];
  const W2 = [1.2, -0.7], B2 = 0;
  const L1_SAMPLES = [[1, 0.5], [-0.5, 1]];
  const L1_ORDER = ['x1', 'x2', 'h1', 'h2', 'o'];
  const L1_NAMES = ['输入 x₁', '输入 x₂', '隐藏 h₁', '隐藏 h₂', '输出 ŷ'];

  function l1Forward(x) {
    const h1 = Math.tanh(W1[0][0] * x[0] + W1[0][1] * x[1] + B1[0]);
    const h2 = Math.tanh(W1[1][0] * x[0] + W1[1][1] * x[1] + B1[1]);
    const z = W2[0] * h1 + W2[1] * h2 + B2;
    return { h1: h1, h2: h2, o: 1 / (1 + Math.exp(-z)) };
  }
  function l1Color(v) {
    const a = 0.18 + 0.72 * Math.min(1, Math.abs(v));
    return v >= 0 ? 'rgba(239,68,68,' + a + ')' : 'rgba(59,130,246,' + a + ')';
  }
  function startL1() { state.lv = { rev: 0 }; renderL1(); }
  function resetL1() { state.lv.rev = 0; }

  function renderL1() {
    const i = state.task, x = L1_SAMPLES[i], out = l1Forward(x), rev = state.lv.rev;
    const correct = +out.o.toFixed(3);
    const opts = i === 0 ? [0.215, 0.903, correct, 0.412] : [correct, 0.512, 0.795, 0.104];

    const nodes = [
      { id: 'x1', x: 78, y: 92, label: 'x₁', v: x[0] },
      { id: 'x2', x: 78, y: 182, label: 'x₂', v: x[1] },
      { id: 'h1', x: 330, y: 62, label: 'h₁', v: out.h1 },
      { id: 'h2', x: 330, y: 162, label: 'h₂', v: out.h2 },
      { id: 'o', x: 582, y: 127, label: 'ŷ', v: out.o }
    ];
    const edges = [[0, 2, W1[0][0]], [1, 2, W1[0][1]], [0, 3, W1[1][0]], [1, 3, W1[1][1]], [2, 4, W2[0]], [3, 4, W2[1]]];
    let svg = '<svg id="netSvg" class="net-svg" viewBox="0 0 660 250">';
    edges.forEach((e) => {
      const a = nodes[e[0]], b = nodes[e[1]], w = e[2];
      svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
        '" stroke="' + (w >= 0 ? '#fca5a5' : '#93c5fd') + '" stroke-width="' + (1.5 + Math.abs(w) * 2) + '"/>';
    });
    nodes.forEach((n, k) => {
      const done = k < rev, next = k === rev;
      svg += '<g data-node="' + n.id + '" class="net-node ' + (done ? 'done' : (next ? 'next' : '')) + '">' +
        '<circle cx="' + n.x + '" cy="' + n.y + '" r="24" fill="' + (done ? l1Color(n.v) : '#eef2ff') +
        '" stroke="' + (done ? '#475569' : '#94a3b8') + '" stroke-width="2"/>' +
        '<text class="net-label" x="' + n.x + '" y="' + (n.y + 4) + '" text-anchor="middle">' + n.label + '</text>' +
        '<text class="net-value" x="' + n.x + '" y="' + (n.y + 40) + '" text-anchor="middle">' + (done ? n.v.toFixed(3) : '?') + '</text>' +
        '</g>';
    });
    svg += '<text class="net-caption" x="78" y="28" text-anchor="middle">输入层</text>' +
      '<text class="net-caption" x="330" y="28" text-anchor="middle">隐藏层（tanh）</text>' +
      '<text class="net-caption" x="582" y="28" text-anchor="middle">输出层（sigmoid）</text></svg>';

    const steps = L1_NAMES.map((nm, k) =>
      '<div class="step-item ' + (k < rev ? 'done' : (k === rev ? 'active' : '')) + '"><b>' + (k + 1) + '</b>' + nm + '</div>').join('');

    $('levelArea').innerHTML = levelHead('样本 ' + (i + 1) + ' / 2 · 输入 [' + x.join(', ') + ']', '按顺序点击 5 个节点') +
      '<div class="two-col"><div class="panel-box">' + svg +
      '<p class="hint-line">点击金色描边的节点；点亮全部节点后才能选择答案。</p></div>' +
      '<div><div class="panel-box"><h3>传播顺序</h3><div class="step-list">' + steps + '</div></div>' +
      '<div class="panel-box" id="answerBox" style="margin-top:14px;' + (rev < 5 ? 'opacity:.55' : '') + '">' +
      '<h3>输出层预测值 ŷ = ?</h3>' +
      '<div class="options">' + opts.map((o, k) => '<button class="opt" data-opt="' + k + '"' + (rev < 5 ? ' disabled' : '') + '>' + o.toFixed(3) + '</button>').join('') +
      '</div></div></div></div></div>';

    $('netSvg').addEventListener('click', (e) => {
      const g = e.target.closest('[data-node]');
      if (!g) return;
      const id = g.getAttribute('data-node');
      if (id !== L1_ORDER[state.lv.rev]) {
        taskResult(false, '顺序不对', '前向传播必须按 输入层 → 隐藏层 → 输出层 的顺序进行，请从金色节点重新开始。', 0);
        return;
      }
      state.lv.rev++;
      renderL1();
    });
    Array.from(document.querySelectorAll('[data-opt]')).forEach((b) => {
      b.onclick = () => {
        const chosen = opts[+b.getAttribute('data-opt')];
        const ok = Math.abs(chosen - correct) < 1e-6;
        const pts = state.taskRetries === 0 ? 120 : 70;
        taskResult(ok,
          ok ? '预测正确' : '数值有误',
          ok ? ('ŷ = σ(1.2×' + fmt(out.h1) + ' − 0.7×' + fmt(out.h2) + ') ≈ ' + correct + '。你掌握了前向传播的逐层计算。')
            : ('正确值约为 ' + correct + '。先算隐藏层 tanh，再算输出层 sigmoid，注意符号。'),
          ok ? pts : 0);
      };
    });
  }

  /* ==================== 关卡 2：权重调参画分界线 ==================== */

  const L2_POINTS = [
    { x: 0.45, y: 0.30, c: 1 }, { x: 0.60, y: -0.12, c: 1 }, { x: 0.20, y: 0.62, c: 1 },
    { x: -0.45, y: -0.30, c: -1 }, { x: -0.60, y: 0.10, c: -1 }, { x: -0.20, y: -0.62, c: -1 }
  ];
  function l2Eval(w1, w2, b) {
    let min = Infinity, ok = true;
    L2_POINTS.forEach((p) => {
      const s = (w1 * p.x + w2 * p.y + b) * p.c;
      min = Math.min(min, s);
      if (s <= 0.12) ok = false;
    });
    return { ok: ok, min: min };
  }
  function startL2() { state.lv = { w1: 1, w2: -0.6, b: 0, moves: 0, solved: false }; renderL2(); }

  function drawL2() {
    const c = $('l2Canvas'); if (!c) return;
    const ctx = c.getContext('2d'), S = c.width;
    const px = (v) => (v + 1) / 2 * S, py = (v) => S - (v + 1) / 2 * S;
    const w1 = state.lv.w1, w2 = state.lv.w2, b = state.lv.b;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#fbfdff'; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#e8eef6'; ctx.lineWidth = 1;
    for (let i = -1; i <= 1; i += 0.5) {
      ctx.beginPath(); ctx.moveTo(px(i), 0); ctx.lineTo(px(i), S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, py(i)); ctx.lineTo(S, py(i)); ctx.stroke();
    }
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px(0), 0); ctx.lineTo(px(0), S); ctx.moveTo(0, py(0)); ctx.lineTo(S, py(0)); ctx.stroke();

    ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (Math.abs(w2) > 0.03) {
      let started = false;
      for (let k = 0; k <= 100; k++) {
        const x = -1 + 2 * k / 100, y = -(w1 * x + b) / w2;
        if (y >= -1 && y <= 1) {
          if (!started) { ctx.moveTo(px(x), py(y)); started = true; }
          else ctx.lineTo(px(x), py(y));
        }
      }
    } else if (Math.abs(w1) > 1e-6) {
      const x = -b / w1;
      if (x >= -1 && x <= 1) { ctx.moveTo(px(x), 0); ctx.lineTo(px(x), S); }
    }
    ctx.stroke();

    L2_POINTS.forEach((p) => {
      const s = (w1 * p.x + w2 * p.y + b) * p.c;
      ctx.beginPath(); ctx.arc(px(p.x), py(p.y), 7, 0, Math.PI * 2);
      ctx.fillStyle = p.c === 1 ? '#ef4444' : '#3b82f6'; ctx.fill();
      ctx.strokeStyle = s > 0 ? '#fff' : '#0f172a'; ctx.lineWidth = s > 0 ? 2 : 2.5; ctx.stroke();
    });
  }

  function renderL2() {
    const lv = state.lv, res = l2Eval(lv.w1, lv.w2, lv.b);
    const correctCount = L2_POINTS.filter((p) => (lv.w1 * p.x + lv.w2 * p.y + lv.b) * p.c > 0).length;
    $('levelArea').innerHTML = levelHead('调参任务 · 让 6 个点全部分类正确', '已调整 ' + lv.moves + ' 次') +
      '<div class="two-col"><div class="panel-box"><canvas id="l2Canvas" class="board" width="320" height="320"></canvas>' +
      '<p class="hint-line">红点属于类别 1，蓝点属于类别 0；粗黑描边表示该点分错。紫色线为当前分界线 w₁x+w₂y+b=0。</p></div>' +
      '<div><div class="panel-box"><h3>调整参数</h3>' +
      '<div class="slider-field"><label>权重 w₁ <output id="w1Out">' + lv.w1.toFixed(2) + '</output></label><input type="range" id="w1" min="-2" max="2" step="0.05" value="' + lv.w1 + '"></div>' +
      '<div class="slider-field"><label>权重 w₂ <output id="w2Out">' + lv.w2.toFixed(2) + '</output></label><input type="range" id="w2" min="-2" max="2" step="0.05" value="' + lv.w2 + '"></div>' +
      '<div class="slider-field"><label>偏置 b <output id="bOut">' + lv.b.toFixed(2) + '</output></label><input type="range" id="b" min="-1" max="1" step="0.05" value="' + lv.b + '"></div>' +
      '<button class="btn btn-ghost" id="hintBtn">查看提示</button></div>' +
      '<div class="panel-box" style="margin-top:14px"><h3>当前状态</h3>' +
      '<div class="info-row"><span>分类正确</span><strong>' + correctCount + ' / 6</strong></div>' +
      '<div class="info-row"><span>最小间隔</span><strong>' + fmt(res.min) + '</strong></div>' +
      '<div class="info-row"><span>通关要求</span><strong>6 / 6 且间隔 &gt; 0.12</strong></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (correctCount / 6 * 100) + '%"></div></div></div>' +
      '</div></div></div>';

    drawL2();
    ['w1', 'w2', 'b'].forEach((id) => {
      $(id).addEventListener('input', (e) => {
        lv[id] = +e.target.value;
        lv.moves++;
        $(id + 'Out').textContent = lv[id].toFixed(2);
        drawL2();
        const r = l2Eval(lv.w1, lv.w2, lv.b);
        const cnt = L2_POINTS.filter((p) => (lv.w1 * p.x + lv.w2 * p.y + lv.b) * p.c > 0).length;
        const info = document.querySelectorAll('.info-row strong');
        if (info[0]) info[0].textContent = cnt + ' / 6';
        if (info[1]) info[1].textContent = fmt(r.min);
        const bar = document.querySelector('.bar-fill');
        if (bar) bar.style.width = (cnt / 6 * 100) + '%';
        if (r.ok && !lv.solved) {
          lv.solved = true;
          const pts = 100 + Math.max(0, 60 - lv.moves * 6);
          taskResult(true, '分界线画好了', '6 个点全部正确，最小间隔 ' + fmt(r.min) + '。你也验证了：权重决定分界线方向，偏置决定它的位置。', pts);
        }
      });
    });
    $('hintBtn').onclick = () => showModal(
      '<div class="modal-kicker">提示</div><h2>让分界线倾斜对方向</h2>' +
      '<p>红点主要分布在右上方，蓝点主要分布在左下方。试着让 w₁ 和 w₂ 同为正数，b 保持在 0 附近，再看哪些点仍被描黑。</p>' +
      '<div class="modal-actions"><button class="btn btn-primary" id="modalNext">明白了</button></div>',
      { modalNext: () => {} }
    );
  }

  /* ==================== 关卡 3：学习率选择 ==================== */

  const L3_ROUNDS = [
    { a: 1, c: 2, w0: 0, opts: [0.05, 0.25, 0.5, 1.5], good: 0.5 },
    { a: 1, c: -1, w0: 3, opts: [0.1, 0.3, 0.5, 0.9], good: 0.5 },
    { a: 4, c: 1, w0: 0, opts: [0.05, 0.125, 0.2, 0.4], good: 0.125 }
  ];
  function startL3() { state.lv = {}; renderL3(); }

  function renderL3() {
    const r = L3_ROUNDS[state.task];
    const loss = (w) => r.a * (w - r.c) * (w - r.c);
    const L0 = loss(r.w0), g = 2 * r.a * (r.w0 - r.c);
    const wmin = Math.min(r.w0, r.c) - 2.2, wmax = Math.max(r.w0, r.c) + 2.2;
    let ymax = Math.max(loss(wmin), loss(wmax), L0);
    ymax = Math.min(ymax, 30);
    const X = (w) => 50 + (w - wmin) / (wmax - wmin) * 420;
    const Y = (v) => 190 - clamp(v / ymax, 0, 1) * 160;
    let pts = [];
    for (let k = 0; k <= 80; k++) {
      const w = wmin + (wmax - wmin) * k / 80;
      pts.push(X(w).toFixed(1) + ',' + Y(loss(w)).toFixed(1));
    }
    const svg = '<svg class="chart" viewBox="0 0 500 220">' +
      '<line class="axis-line" x1="50" y1="190" x2="470" y2="190"/>' +
      '<line class="axis-line" x1="50" y1="30" x2="50" y2="190"/>' +
      '<line class="grid-line" x1="' + X(r.c) + '" y1="30" x2="' + X(r.c) + '" y2="190" stroke="#86efac"/>' +
      '<polyline class="curve" points="' + pts.join(' ') + '"/>' +
      '<circle cx="' + X(r.w0) + '" cy="' + Y(L0) + '" r="6" fill="#f59e0b" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="' + X(r.c) + '" cy="190" r="5" fill="#22c55e"/>' +
      '<text class="chart-text" x="' + (X(r.w0) - 6) + '" y="' + (Y(L0) - 12) + '">当前</text>' +
      '<text class="chart-text" x="' + (X(r.c) - 10) + '" y="207">最低点</text>' +
      '<text class="chart-text" x="10" y="24">L(w)</text><text class="chart-text" x="460" y="207">w</text></svg>';

    $('levelArea').innerHTML = levelHead('第 ' + (state.task + 1) + ' / 3 轮 · 选择学习率', '目标：一次更新把损失降到 0.05 以下') +
      '<div class="two-col"><div class="panel-box">' + svg +
      '<div class="formula-box">L(w) = ' + r.a + '(w − ' + r.c + ')²　|　当前 w = ' + r.w0 + '　|　梯度 = ' + fmt(g, 2) +
      '　|　w ← w − η × 梯度</div></div>' +
      '<div class="panel-box"><h3>当前状态</h3>' +
      '<div class="info-row"><span>当前损失</span><strong>' + fmt(L0) + '</strong></div>' +
      '<div class="info-row"><span>目标损失</span><strong>&lt; 0.05</strong></div>' +
      '<h3 style="margin-top:16px">选择学习率 η</h3>' +
      '<div class="opt-row4">' + r.opts.map((o, k) => '<button class="opt" data-eta="' + k + '">' + o + '</button>').join('') + '</div>' +
      '<p class="hint-line">太小的 η 一步走不到低点；太大的 η 会越过最低点。</p></div></div></div>';

    Array.from(document.querySelectorAll('[data-eta]')).forEach((b) => {
      b.onclick = () => {
        const eta = r.opts[+b.getAttribute('data-eta')];
        const w1 = r.w0 - eta * g, L1 = loss(w1);
        const ok = L1 < 0.05;
        const pts = state.taskRetries === 0 ? 100 : 60;
        let msg;
        if (ok) {
          msg = 'η = ' + eta + '：w 从 ' + r.w0 + ' 更新到 ' + fmt(w1) + '，损失 ' + fmt(L0) + ' → ' + fmt(L1) + '。这一步刚好落在最低点附近。';
        } else if (L1 > L0) {
          msg = 'η = ' + eta + ' 太大了：w 被推到 ' + fmt(w1) + '，反而越过最低点，损失升到 ' + fmt(L1) + '。';
        } else {
          msg = 'η = ' + eta + ' 太小了：w 只走到 ' + fmt(w1) + '，损失仍有 ' + fmt(L1) + '，需要很多轮才能收敛。';
        }
        taskResult(ok, ok ? '学习率选对了' : '再调整一下', msg, ok ? pts : 0);
      };
    });
  }

  /* ==================== 关卡 4：梯度方向侦探 ==================== */

  const L4_ROUNDS = [
    { p: [2, 1], opts: [[-1, -1], [-1, 0], [0, -1], [1, 1]], good: 0 },
    { p: [-1, 2], opts: [[1, -4], [-1, -1], [1, 1], [0, 1]], good: 0 },
    { p: [0, -1.5], opts: [[0, 1], [1, 0], [-1, 0], [0, -1]], good: 0 }
  ];
  function startL4() { state.lv = {}; renderL4(); }

  function renderL4() {
    const r = L4_ROUNDS[state.task], g = [2 * r.p[0], 4 * r.p[1]];
    const S = 330, mid = S / 2, scale = 46;
    const P = (x, y) => [mid + x * scale, mid - y * scale];
    let svg = '<svg id="contour" viewBox="0 0 ' + S + ' ' + S + '" style="width:100%;max-width:330px;display:block">';
    svg += '<rect width="' + S + '" height="' + S + '" fill="#fbfdff"/>';
    [1, 2, 4, 8, 14].forEach((c) => {
      svg += '<ellipse cx="' + mid + '" cy="' + mid + '" rx="' + (Math.sqrt(c) * scale) + '" ry="' + (Math.sqrt(c / 2) * scale) +
        '" fill="none" stroke="#cbd5e1" stroke-width="1"/>';
    });
    const zero = P(0, 0);
    svg += '<line x1="0" y1="' + zero[1] + '" x2="' + S + '" y2="' + zero[1] + '" stroke="#e2e8f0"/>' +
      '<line x1="' + zero[0] + '" y1="0" x2="' + zero[0] + '" y2="' + S + '" stroke="#e2e8f0"/>';
    const pp = P(r.p[0], r.p[1]);
    r.opts.forEach((d, i) => {
      const len = Math.hypot(d[0], d[1]);
      const ex = pp[0] + d[0] / len * 62, ey = pp[1] - d[1] / len * 62;
      const ang = Math.atan2(ey - pp[1], ex - pp[0]);
      const a1 = ang + 2.6, a2 = ang - 2.6;
      const p1 = [ex + 10 * Math.cos(a1), ey + 10 * Math.sin(a1)];
      const p2 = [ex + 10 * Math.cos(a2), ey + 10 * Math.sin(a2)];
      svg += '<g class="arrow-btn" data-dir="' + i + '">' +
        '<line x1="' + pp[0] + '" y1="' + pp[1] + '" x2="' + ex + '" y2="' + ey + '" stroke="#7c3aed" stroke-width="3" stroke-linecap="round"/>' +
        '<polygon points="' + ex + ',' + ey + ' ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + '" fill="#7c3aed"/>' +
        '<circle cx="' + ((pp[0] + ex) / 2) + '" cy="' + ((pp[1] + ey) / 2) + '" r="17" fill="transparent"/></g>';
    });
    svg += '<circle cx="' + pp[0] + '" cy="' + pp[1] + '" r="7" fill="#f59e0b" stroke="#fff" stroke-width="2"/>' +
      '<text x="' + (pp[0] + 10) + '" y="' + (pp[1] - 10) + '" class="chart-text">(' + r.p.join(', ') + ')</text></svg>';

    const names = ['方向 A', '方向 B', '方向 C', '方向 D'];
    $('levelArea').innerHTML = levelHead('第 ' + (state.task + 1) + ' / 3 轮 · 找出负梯度方向', '损失函数 L(x,y) = x² + 2y²') +
      '<div class="two-col"><div class="panel-box">' + svg +
      '<p class="hint-line">椭圆是损失等高线，同一条椭圆上损失相同；箭头从当前位置出发。</p></div>' +
      '<div class="panel-box"><h3>当前位置 (' + r.p.join(', ') + ')</h3>' +
      '<div class="info-row"><span>梯度 ∇L</span><strong>(' + fmt(g[0], 1) + ', ' + fmt(g[1], 1) + ')</strong></div>' +
      '<div class="formula-box">下降最快的方向 = 负梯度 −∇L（与梯度完全相反），请自己把上面的梯度取反</div>' +
      '<h3>选择下降方向</h3><div class="options">' +
      r.opts.map((d, i) => '<button class="opt" data-dir="' + i + '">' + names[i] + '　(' + d[0] + ', ' + d[1] + ')</button>').join('') +
      '</div></div></div>';

    const choose = (i) => {
      const ok = i === r.good;
      const pts = state.taskRetries === 0 ? 100 : 60;
      const msg = ok
        ? '正确！梯度 (' + fmt(g[0], 1) + ', ' + fmt(g[1], 1) + ') 指向损失上升方向，反方向 (' + fmt(-g[0], 1) + ', ' + fmt(-g[1], 1) + ') 才是下降最快的方向。'
        : '不对。该点的梯度是 (' + fmt(g[0], 1) + ', ' + fmt(g[1], 1) + ')，训练要沿它的反方向 (' + fmt(-g[0], 1) + ', ' + fmt(-g[1], 1) + ') 走。';
      if (!ok) {
        const arrow = document.querySelector('[data-dir="' + i + '"]');
        if (arrow) arrow.classList.add('wrong');
      }
      taskResult(ok, ok ? '方向判断正确' : '方向选错了', msg, ok ? pts : 0);
    };
    Array.from(document.querySelectorAll('[data-dir]')).forEach((el) => {
      el.onclick = () => choose(+el.getAttribute('data-dir'));
    });
  }

  /* ==================== 关卡 5：终极训练挑战（真实训练） ==================== */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeData(kind) {
    const rnd = mulberry32(20240617), N = 160, X = [], y = [];
    for (let i = 0; i < N; i++) {
      if (kind === 'xor') {
        let a = (rnd() * 2 - 1) * 0.95, b = (rnd() * 2 - 1) * 0.95;
        a += a >= 0 ? 0.09 : -0.09; b += b >= 0 ? 0.09 : -0.09;
        X.push([a, b]); y.push((a > 0) !== (b > 0) ? 1 : 0);
      } else {
        const label = i % 2, r = label ? 0.72 + 0.2 * rnd() : 0.18 + 0.24 * rnd();
        const th = rnd() * Math.PI * 2;
        X.push([r * Math.cos(th), r * Math.sin(th)]); y.push(label);
      }
    }
    return { X: X, y: y };
  }
  function initNet(sizes, seed) {
    const rnd = mulberry32(seed), W = [], b = [];
    for (let l = 1; l < sizes.length; l++) {
      const fin = sizes[l - 1], fout = sizes[l], scale = Math.sqrt(6 / (fin + fout));
      const m = [];
      for (let i = 0; i < fout; i++) {
        const row = [];
        for (let j = 0; j < fin; j++) row.push((rnd() * 2 - 1) * scale);
        m.push(row);
      }
      W.push(m); b.push(new Array(fout).fill(0));
    }
    return { W: W, b: b };
  }
  function netForward(net, x, sizes) {
    const A = [x.slice()], Z = [null];
    for (let l = 0; l < net.W.length; l++) {
      const prev = A[l], z = new Array(sizes[l + 1]).fill(0);
      for (let i = 0; i < sizes[l + 1]; i++) {
        let s = net.b[l][i];
        for (let j = 0; j < sizes[l]; j++) s += net.W[l][i][j] * prev[j];
        z[i] = s;
      }
      Z.push(z);
      A.push(l === net.W.length - 1 ? z.map((v) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))))) : z.map(Math.tanh));
    }
    return { A: A, Z: Z };
  }
  function netBackward(net, cache, y, sizes) {
    const L = net.W.length, D = new Array(L + 1), gW = [], gb = [];
    D[L] = cache.A[L].map((a) => a - y);
    for (let l = L - 1; l >= 0; l--) {
      const prev = cache.A[l], gw = [], gbl = new Array(sizes[l + 1]).fill(0);
      for (let i = 0; i < sizes[l + 1]; i++) {
        gbl[i] = D[l + 1][i];
        const row = new Array(sizes[l]).fill(0);
        for (let j = 0; j < sizes[l]; j++) row[j] = D[l + 1][i] * prev[j];
        gw.push(row);
      }
      gW[l] = gw; gb[l] = gbl;
      if (l > 0) {
        const d = new Array(sizes[l]).fill(0);
        for (let j = 0; j < sizes[l]; j++) {
          let s = 0;
          for (let i = 0; i < sizes[l + 1]; i++) s += net.W[l][i][j] * D[l + 1][i];
          d[j] = s * (1 - cache.A[l][j] * cache.A[l][j]);
        }
        D[l] = d;
      }
    }
    return { gW: gW, gb: gb };
  }
  function trainGame(cfg) {
    const sizes = [2, cfg.hidden, 1], data = makeData(cfg.dataset);
    const net = initNet(sizes, 987654321), N = data.X.length, snaps = [];
    for (let epoch = 0; epoch <= cfg.epochs; epoch++) {
      const gW = net.W.map((m) => m.map((r) => r.map(() => 0)));
      const gb = net.b.map((v) => v.map(() => 0));
      let loss = 0, correct = 0;
      for (let k = 0; k < N; k++) {
        const cache = netForward(net, data.X[k], sizes);
        const p = Math.min(1 - 1e-9, Math.max(1e-9, cache.A[2][0]));
        loss += -(data.y[k] * Math.log(p) + (1 - data.y[k]) * Math.log(1 - p));
        if ((p >= 0.5 ? 1 : 0) === data.y[k]) correct++;
        const g = netBackward(net, cache, data.y[k], sizes);
        for (let l = 0; l < 2; l++) {
          for (let i = 0; i < g.gW[l].length; i++) {
            for (let j = 0; j < g.gW[l][i].length; j++) gW[l][i][j] += g.gW[l][i][j];
            gb[l][i] += g.gb[l][i];
          }
        }
      }
      for (let l = 0; l < 2; l++) {
        for (let i = 0; i < gW[l].length; i++) {
          for (let j = 0; j < gW[l][i].length; j++) gW[l][i][j] /= N;
          gb[l][i] /= N;
        }
      }
      snaps.push({ epoch: epoch, loss: loss / N, acc: correct / N });
      if (epoch < cfg.epochs) {
        for (let l = 0; l < 2; l++) {
          for (let i = 0; i < net.W[l].length; i++) {
            for (let j = 0; j < net.W[l][i].length; j++) net.W[l][i][j] -= cfg.lr * gW[l][i][j];
            net.b[l][i] -= cfg.lr * gb[l][i];
          }
        }
      }
    }
    return snaps;
  }
  function startL5() {
    state.lv = { attempts: 0, training: false, timer: null,
      sel: { dataset: 'xor', hidden: '8', lr: '0.5', epochs: '150' } };
    renderL5();
  }

  function renderL5() {
    const s = state.lv.sel;
    $('levelArea').innerHTML = levelHead('配置并训练网络 · 目标准确率 ≥ 90%', '已尝试 ' + (state.lv.attempts + 1) + ' 次') +
      '<div class="two-col"><div class="panel-box">' +
      '<h3>训练配置</h3>' +
      '<div class="slider-field"><label>数据集</label><select id="cfgDataset">' +
      '<option value="xor"' + (s.dataset === 'xor' ? ' selected' : '') + '>异或 XOR（较难）</option>' +
      '<option value="circles"' + (s.dataset === 'circles' ? ' selected' : '') + '>同心圆</option></select></div>' +
      '<div class="slider-field"><label>隐藏层神经元数 <output id="hiddenOut">' + s.hidden + '</output></label>' +
      '<input type="range" id="cfgHidden" min="2" max="10" step="1" value="' + s.hidden + '"></div>' +
      '<div class="slider-field"><label>学习率</label><select id="cfgLr">' +
      [['0.05', '0.05（偏小）'], ['0.2', '0.2（适中）'], ['0.5', '0.5（偏大但更快）']].map((o) =>
        '<option value="' + o[0] + '"' + (s.lr === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="slider-field"><label>训练轮数</label><select id="cfgEpochs">' +
      [['50', '50 轮'], ['150', '150 轮'], ['300', '300 轮']].map((o) =>
        '<option value="' + o[0] + '"' + (s.epochs === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<button class="btn btn-primary" id="trainBtn" style="width:100%;margin-top:8px">开始训练</button>' +
      '<p class="hint-line">提示：容量太小、学习率太小或轮数太少，都会导致准确率上不去。</p></div>' +
      '<div class="panel-box"><h3>训练实况</h3>' +
      '<div class="train-stats"><div class="train-stat"><span>轮次</span><strong id="tEpoch">0</strong></div>' +
      '<div class="train-stat"><span>损失</span><strong id="tLoss">—</strong></div>' +
      '<div class="train-stat"><span>准确率</span><strong id="tAcc">—</strong></div></div>' +
      '<div class="bar-track"><div class="bar-fill" id="tBar" style="width:0%"></div></div>' +
      '<svg id="trainChart" class="chart" viewBox="0 0 320 150" style="margin-top:12px"></svg>' +
      '<p class="hint-line">紫线 = 损失，绿线 = 准确率。训练结束后按最终准确率判定通关。</p></div></div></div>';

    $('cfgHidden').oninput = (e) => { s.hidden = e.target.value; $('hiddenOut').textContent = s.hidden; };
    $('cfgDataset').onchange = (e) => { s.dataset = e.target.value; };
    $('cfgLr').onchange = (e) => { s.lr = e.target.value; };
    $('cfgEpochs').onchange = (e) => { s.epochs = e.target.value; };
    $('trainBtn').onclick = runTraining;
  }

  function drawTrainChart(snaps, upto, maxLoss) {
    const svg = $('trainChart'); if (!svg) return;
    const W = 320, H = 150, pl = 32, pr = 8, pt = 10, pb = 20;
    const n = Math.max(2, upto + 1);
    const X = (i) => pl + (W - pl - pr) * i / (snaps.length - 1);
    const Yl = (v) => pt + (H - pt - pb) * (1 - clamp(v / maxLoss, 0, 1));
    const Ya = (v) => pt + (H - pt - pb) * (1 - v);
    let out = '<line class="grid-line" x1="' + pl + '" y1="' + (H - pb) + '" x2="' + (W - pr) + '" y2="' + (H - pb) + '"/>';
    out += '<text class="chart-text" x="4" y="16">' + maxLoss.toFixed(2) + '</text><text class="chart-text" x="18" y="' + (H - pb) + '">0</text>';
    const ptsL = [], ptsA = [];
    for (let i = 0; i <= upto; i++) {
      ptsL.push(X(i).toFixed(1) + ',' + Yl(snaps[i].loss).toFixed(1));
      ptsA.push(X(i).toFixed(1) + ',' + Ya(snaps[i].acc).toFixed(1));
    }
    out += '<polyline points="' + ptsL.join(' ') + '" fill="none" stroke="#7c3aed" stroke-width="2"/>';
    out += '<polyline points="' + ptsA.join(' ') + '" fill="none" stroke="#059669" stroke-width="2"/>';
    svg.innerHTML = out;
  }

  function runTraining() {
    if (state.lv.training) return;
    const s = state.lv.sel;
    const cfg = { dataset: s.dataset, hidden: +s.hidden, lr: +s.lr, epochs: +s.epochs };
    state.lv.training = true;
    $('trainBtn').disabled = true;
    $('trainBtn').textContent = '训练中…';
    ['cfgDataset', 'cfgHidden', 'cfgLr', 'cfgEpochs'].forEach((id) => { $(id).disabled = true; });

    const snaps = trainGame(cfg);
    const maxLoss = Math.max.apply(null, snaps.map((x) => x.loss)) * 1.05;
    const step = Math.max(1, Math.ceil(cfg.epochs / 100));
    let i = 0;
    drawTrainChart(snaps, 0, maxLoss);
    state.lv.timer = setInterval(() => {
      i = Math.min(snaps.length - 1, i + step);
      const cur = snaps[i];
      $('tEpoch').textContent = cur.epoch;
      $('tLoss').textContent = fmt(cur.loss);
      $('tAcc').textContent = (cur.acc * 100).toFixed(1) + '%';
      $('tBar').style.width = (cur.epoch / cfg.epochs * 100) + '%';
      drawTrainChart(snaps, i, maxLoss);
      if (i >= snaps.length - 1) {
        clearInterval(state.lv.timer);
        state.lv.timer = null;
        finishTraining(cfg, snaps);
      }
    }, 32);
  }

  function finishTraining(cfg, snaps) {
    state.lv.training = false;
    const final = snaps[snaps.length - 1];
    const firstHit = snaps.findIndex((s) => s.acc >= 0.9);
    const ok = final.acc >= 0.9;
    if (ok) {
      const speedBonus = firstHit >= 0 ? Math.round((cfg.epochs - firstHit) / cfg.epochs * 50) : 0;
      const pts = 200 + Math.max(0, 100 - state.lv.attempts * 40) + speedBonus;
      taskResult(true, '挑战成功',
        '最终准确率 ' + (final.acc * 100).toFixed(1) + '%，损失 ' + fmt(final.loss) + '。' +
        (firstHit >= 0 ? '在第 ' + firstHit + ' 轮就达到 90%。' : '') +
        '你综合运用了网络容量、学习率和训练轮数三项知识。', pts);
    } else {
      state.lv.attempts++;
      let hint;
      if (cfg.hidden <= 3 && cfg.dataset === 'xor') hint = '隐藏神经元可能太少，试着增加到 4 个以上。';
      else if (cfg.lr <= 0.05) hint = '学习率太小，损失下降缓慢，试着提高到 0.2 或 0.5。';
      else if (cfg.epochs <= 50) hint = '训练轮数不足，试试 150 轮或更多。';
      else hint = '当前配置收敛不理想，可以增大网络容量并提高学习率后再试。';
      taskResult(false, '本次未达标',
        '最终准确率 ' + (final.acc * 100).toFixed(1) + '%，未达到 90%。' + hint,
        0, () => renderL5());
    }
  }

  /* ==================== 启动 ==================== */
  $('startBtn').onclick = startGame;
  $('homeBtn').onclick = backHome;
})();
