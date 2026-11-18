/* MLP 训练可视化实验室 —— 纯前端实现，无外部依赖 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    dataset: $('dataset'), hiddenCount: $('hiddenCount'), hiddenSize: $('hiddenSize'),
    lr: $('lr'), epochs: $('epochs'), activation: $('activation'), retrainBtn: $('retrainBtn'),
    hiddenCountOut: $('hiddenCountOut'), hiddenSizeOut: $('hiddenSizeOut'),
    lrOut: $('lrOut'), epochsOut: $('epochsOut'), speedOut: $('speedOut'), scrubOut: $('scrubOut'),
    prevBtn: $('prevBtn'), playBtn: $('playBtn'), nextBtn: $('nextBtn'), resetBtn: $('resetBtn'),
    scrub: $('scrub'), speed: $('speed'), edgeMode: $('edgeMode'), demoBtn: $('demoBtn'),
    statEpoch: $('statEpoch'), statLoss: $('statLoss'), statAcc: $('statAcc'), statState: $('statState'),
    networkSvg: $('networkSvg'), forwardPanel: $('forwardPanel'), tagProbe: $('tagProbe'),
    boundaryCanvas: $('boundaryCanvas'), weightMaps: $('weightMaps'), gradMaps: $('gradMaps'),
    biasBars: $('biasBars'), lossChart: $('lossChart'), accChart: $('accChart'),
    deltaChart: $('deltaChart'), weightTrajectory: $('weightTrajectory'),
    paramTitle: $('paramTitle'), updateDetail: $('updateDetail')
  };

  const state = {
    cfg: { dataset: 'circles', hiddenCount: 2, hiddenSize: 8, lr: Math.pow(10, -3 + 0.92 * 2.7), epochs: 200, activation: 'tanh' },
    snaps: [], sizes: [], data: null,
    epoch: 0, playing: false, timer: null, speed: 8,
    probeIndex: 0, edgeMode: 'weight',
    selected: { kind: 'W', l: 0, i: 0, j: 0 },
    demoStep: -1, demoTimer: null
  };

  const SUP = ['', '¹', '²', '³', '⁴'];
  const layerName = (l) => (l === 0 ? '输入层' : (l === state.sizes.length - 1 ? '输出层' : '隐藏层 ' + l));
  const fmt = (v, d) => {
    d = d === undefined ? 4 : d;
    if (!isFinite(v)) return '—';
    if (Math.abs(v) < 1e-4 && v !== 0) return v.toExponential(1);
    return v.toFixed(d);
  };

  /* ==================== 数据与网络数学 ==================== */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function makeDataset(kind) {
    const rnd = mulberry32(20240617);
    const N = 180, X = [], y = [];
    for (let i = 0; i < N; i++) {
      if (kind === 'circles') {
        const label = i % 2;
        const r = label ? 0.72 + 0.20 * rnd() : 0.18 + 0.24 * rnd();
        const th = rnd() * Math.PI * 2;
        X.push([r * Math.cos(th), r * Math.sin(th)]);
        y.push(label);
      } else if (kind === 'xor') {
        let a = (rnd() * 2 - 1) * 0.95, b = (rnd() * 2 - 1) * 0.95;
        a += a >= 0 ? 0.09 : -0.09;
        b += b >= 0 ? 0.09 : -0.09;
        X.push([a, b]);
        y.push((a > 0) !== (b > 0) ? 1 : 0);
      } else {
        const label = i % 2;
        const cx = label ? 0.42 : -0.42;
        X.push([cx + (rnd() - 0.5) * 0.55, (rnd() - 0.5) * 0.95]);
        y.push(label);
      }
    }
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tx = X[i]; X[i] = X[j]; X[j] = tx;
      const ty = y[i]; y[i] = y[j]; y[j] = ty;
    }
    return { X: X, y: y };
  }

  function actFn(name) {
    if (name === 'relu') return { f: (z) => Math.max(0, z), df: (z, a) => (a > 0 ? 1 : 0) };
    return { f: (z) => Math.tanh(z), df: (z, a) => 1 - a * a };
  }

  function sigmoid(z) {
    z = Math.max(-30, Math.min(30, z));
    return 1 / (1 + Math.exp(-z));
  }

  function initNetwork(sizes, activation, seed) {
    const rnd = mulberry32(seed);
    const W = [], b = [];
    for (let l = 1; l < sizes.length; l++) {
      const fanIn = sizes[l - 1], fanOut = sizes[l];
      const scale = activation === 'relu'
        ? Math.sqrt(2 / fanIn)
        : Math.sqrt(6 / (fanIn + fanOut));
      const m = [];
      for (let i = 0; i < fanOut; i++) {
        const row = [];
        for (let j = 0; j < fanIn; j++) row.push((rnd() * 2 - 1) * scale);
        m.push(row);
      }
      W.push(m);
      b.push(new Array(fanOut).fill(0));
    }
    return { W: W, b: b };
  }

  // net = {W,b}; W[l][i][j]：第 l 层第 i 个神经元来自上一层第 j 个输入的权重
  function forward(net, x, sizes, activation) {
    const A = [x.slice()], Z = [null];
    const f = actFn(activation).f;
    const L = net.W.length;
    for (let l = 0; l < L; l++) {
      const prev = A[l], z = new Array(sizes[l + 1]).fill(0);
      for (let i = 0; i < sizes[l + 1]; i++) {
        let s = net.b[l][i], row = net.W[l][i];
        for (let j = 0; j < sizes[l]; j++) s += row[j] * prev[j];
        z[i] = s;
      }
      Z.push(z);
      A.push(l === L - 1 ? z.map(sigmoid) : z.map(f));
    }
    return { A: A, Z: Z };
  }

  function backward(net, cache, y, sizes, activation) {
    const L = net.W.length;
    const df = actFn(activation).df;
    const D = new Array(L + 1);
    const gW = [], gb = [];
    // 输出层 sigmoid + 二元交叉熵 => dz = a - y
    D[L] = cache.A[L].map((a) => a - y);
    for (let l = L - 1; l >= 0; l--) {
      const prev = cache.A[l];
      const gw = [], gbl = new Array(sizes[l + 1]).fill(0);
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
          d[j] = s * df(cache.Z[l][j], cache.A[l][j]);
        }
        D[l] = d;
      }
    }
    return { gW: gW, gb: gb };
  }

  function train(cfg) {
    const sizes = [2];
    for (let i = 0; i < cfg.hiddenCount; i++) sizes.push(cfg.hiddenSize);
    sizes.push(1);
    const data = makeDataset(cfg.dataset);
    const net = initNetwork(sizes, cfg.activation, 987654321);
    const N = data.X.length;
    const snaps = [];

    for (let epoch = 0; epoch <= cfg.epochs; epoch++) {
      const gW = net.W.map((m) => m.map((r) => r.map(() => 0)));
      const gb = net.b.map((v) => v.map(() => 0));
      let loss = 0, correct = 0;

      for (let k = 0; k < N; k++) {
        const cache = forward(net, data.X[k], sizes, cfg.activation);
        const p = Math.min(1 - 1e-9, Math.max(1e-9, cache.A[sizes.length - 1][0]));
        loss += -(data.y[k] * Math.log(p) + (1 - data.y[k]) * Math.log(1 - p));
        if ((p >= 0.5 ? 1 : 0) === data.y[k]) correct++;
        const g = backward(net, cache, data.y[k], sizes, cfg.activation);
        for (let l = 0; l < g.gW.length; l++) {
          for (let i = 0; i < g.gW[l].length; i++) {
            for (let j = 0; j < g.gW[l][i].length; j++) gW[l][i][j] += g.gW[l][i][j];
            gb[l][i] += g.gb[l][i];
          }
        }
      }
      for (let l = 0; l < gW.length; l++) {
        for (let i = 0; i < gW[l].length; i++) {
          for (let j = 0; j < gW[l][i].length; j++) gW[l][i][j] /= N;
          gb[l][i] /= N;
        }
      }

      snaps.push({
        epoch: epoch, loss: loss / N, acc: correct / N,
        W: net.W.map((m) => m.map((r) => r.slice())),
        b: net.b.map((v) => v.slice()),
        gW: gW, gb: gb
      });

      if (epoch < cfg.epochs) {
        for (let l = 0; l < net.W.length; l++) {
          for (let i = 0; i < net.W[l].length; i++) {
            for (let j = 0; j < net.W[l][i].length; j++) net.W[l][i][j] -= cfg.lr * gW[l][i][j];
            net.b[l][i] -= cfg.lr * gb[l][i];
          }
        }
      }
    }
    return { snaps: snaps, sizes: sizes, data: data };
  }

  /* ==================== 颜色与通用绘图 ==================== */

  function colorFor(v, max, baseAlpha) {
    const t = max > 1e-12 ? Math.min(1, Math.abs(v) / max) : 0;
    const a = (baseAlpha === undefined ? 0.12 : baseAlpha) + 0.85 * t;
    const rgb = v >= 0 ? '239,68,68' : '59,130,246';
    return 'rgba(' + rgb + ',' + a.toFixed(3) + ')';
  }

  function maxAbs(arr) {
    let m = 0;
    arr.forEach((v) => { if (isFinite(v)) m = Math.max(m, Math.abs(v)); });
    return m;
  }

  function current() { return state.snaps[state.epoch]; }

  function viewBox(svg) {
    const p = svg.getAttribute('viewBox').split(/\s+/);
    return { w: +p[2], h: +p[3] };
  }

  function drawLineChart(svg, series, opts) {
    opts = opts || {};
    const dim = viewBox(svg), W = dim.w, H = dim.h;
    const pad = { l: 46, r: 14, t: 12, b: 26 };
    const n = series[0].values.length;
    let lo = opts.ymin, hi = opts.ymax;
    if (lo === undefined) {
      lo = Infinity; hi = -Infinity;
      series.forEach((s) => s.values.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
      const span = hi - lo || 1;
      lo -= span * 0.12; hi += span * 0.12;
    }
    const xAt = (i) => pad.l + (W - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
    const yAt = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / ((hi - lo) || 1));
    let out = '';
    for (let g = 0; g <= 4; g++) {
      const yy = pad.t + (H - pad.t - pad.b) * g / 4;
      const val = hi - (hi - lo) * g / 4;
      out += '<line class="grid-line" x1="' + pad.l + '" y1="' + yy + '" x2="' + (W - pad.r) + '" y2="' + yy + '"/>';
      out += '<text class="axis-text" x="' + (pad.l - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + fmt(val, 3) + '</text>';
    }
    out += '<text class="axis-text" x="' + pad.l + '" y="' + (H - 7) + '" text-anchor="start">0</text>';
    out += '<text class="axis-text" x="' + (W - pad.r) + '" y="' + (H - 7) + '" text-anchor="end">' + (n - 1) + ' 轮</text>';
    const nx = xAt(Math.min(state.epoch, n - 1));
    out += '<line class="now-line" x1="' + nx + '" y1="' + pad.t + '" x2="' + nx + '" y2="' + (H - pad.b) + '"/>';
    series.forEach((s) => {
      const pts = s.values.map((v, i) => xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)).join(' ');
      out += '<polyline class="series-line" points="' + pts + '" stroke="' + s.color + '"/>';
      const v = s.values[Math.min(state.epoch, n - 1)];
      out += '<circle class="now-dot" cx="' + nx + '" cy="' + yAt(v) + '" r="4.5" fill="' + s.color + '"/>';
    });
    svg.innerHTML = out;
  }

  /* ==================== 各面板渲染 ==================== */

  function renderNetwork() {
    const snap = current(), sizes = state.sizes;
    const W = 880, H = 340, L = sizes.length;
    const xs = sizes.map((_, i) => 76 + i * (728 / (L - 1)));
    const maxN = Math.max.apply(null, sizes);
    const ys = sizes.map((n) => {
      const gap = Math.min(56, 250 / Math.max(1, n - 1));
      const start = H / 2 - gap * (n - 1) / 2;
      return Array.from({ length: n }, (_, i) => start + i * gap);
    });
    const cache = forward(snap, state.data.X[state.probeIndex], sizes, state.cfg.activation);
    const A = cache.A;

    let out = '';
    // 连线
    for (let l = 0; l < L - 1; l++) {
      const grid = snap.W[l];
      let maxVal = 1e-9;
      grid.forEach((row, i) => row.forEach((w, j) => {
        const val = state.edgeMode === 'contrib' ? Math.abs(w * A[l][i]) : Math.abs(w);
        maxVal = Math.max(maxVal, val);
      }));
      let lines = '';
      for (let i = 0; i < sizes[l]; i++) {
        for (let j = 0; j < sizes[l + 1]; j++) {
          const w = grid[j][i];
          const val = state.edgeMode === 'contrib' ? w * A[l][i] : w;
          const t = Math.min(1, Math.abs(val) / maxVal);
          const sw = 0.7 + 4.2 * t;
          const a = 0.12 + 0.68 * t;
          const rgb = val >= 0 ? '239,68,68' : '59,130,246';
          lines += '<line class="edge" x1="' + xs[l] + '" y1="' + ys[l][i] + '" x2="' + xs[l + 1] + '" y2="' + ys[l + 1][j] +
            '" stroke="rgba(' + rgb + ',' + a.toFixed(2) + ')" stroke-width="' + sw.toFixed(2) + '">' +
            '<title>' + layerName(l) + '[' + i + '] → ' + layerName(l + 1) + '[' + j + ']&#10;W = ' + fmt(w) +
            '&#10;激活值 = ' + fmt(A[l][i]) + '&#10;贡献 = ' + fmt(w * A[l][i]) + '</title></line>';
          // 主导传播路径：对每个目标神经元，取贡献绝对值最大的输入连线
          if (state.edgeMode === 'contrib') {
            let bestI = -1, best = -1;
            for (let q = 0; q < sizes[l]; q++) {
              const c = Math.abs(grid[j][q] * A[l][q]);
              if (c > best) { best = c; bestI = q; }
            }
            if (bestI === i && best > 0) {
              lines += '<line x1="' + xs[l] + '" y1="' + ys[l][i] + '" x2="' + xs[l + 1] + '" y2="' + ys[l + 1][j] +
                '" stroke="#f59e0b" stroke-width="' + (sw + 1.6).toFixed(2) + '" opacity="0.55" pointer-events="none"/>';
            }
          }
        }
      }
      out += '<g class="' + (state.demoStep === l + 1 ? 'pulse' : '') + '">' + lines + '</g>';
    }

    // 节点
    for (let l = 0; l < L; l++) {
      let gnodes = '';
      for (let i = 0; i < sizes[l]; i++) {
        const v = A[l][i];
        const bias = l === 0 ? 0 : snap.b[l - 1][i];
        const r = l === L - 1 ? 15 : 13;
        gnodes += '<circle class="node" cx="' + xs[l] + '" cy="' + ys[l][i] + '" r="' + r +
          '" fill="' + colorFor(v, 1) + '" stroke="' + (l === 0 || l === L - 1 ? '#475569' : '#94a3b8') + '" stroke-width="1.5">' +
          '<title>' + layerName(l) + ' #' + i + '&#10;激活值 a = ' + fmt(v) + (l > 0 ? '&#10;偏置 b = ' + fmt(bias) : '') + '</title></circle>';
        gnodes += '<text class="node-label" x="' + xs[l] + '" y="' + (ys[l][i] + r + 12) + '" text-anchor="middle">' + fmt(v, 2) + '</text>';
      }
      out += '<g class="' + (state.demoStep === l ? 'pulse' : '') + '">' + gnodes + '</g>';
      out += '<text class="layer-caption" x="' + xs[l] + '" y="26" text-anchor="middle">' +
        (l === 0 ? '输入层 (2)' : (l === L - 1 ? '输出层 (1)' : '隐藏层 ' + l + ' (' + sizes[l] + ')')) + '</text>';
    }
    out += '<text class="layer-caption" x="440" y="332" text-anchor="middle">节点下方数值 = 当前样本激活值；金色描边 = 当前样本的主导传播路径（切换到"按激活贡献着色"时显示）</text>';
    els.networkSvg.innerHTML = out;
    els.tagProbe.textContent = '样本 #' + state.probeIndex + ' · y=' + state.data.y[state.probeIndex];
  }

  function renderForward() {
    const snap = current(), sizes = state.sizes;
    const cache = forward(snap, state.data.X[state.probeIndex], sizes, state.cfg.activation);
    let out = '';
    for (let k = 0; k < sizes.length; k++) {
      const name = k === 0 ? '输入层 x' : (k === sizes.length - 1 ? '输出层 ŷ' : '隐藏层 ' + k);
      const formula = k === 0 ? '样本输入：[' + state.data.X[state.probeIndex].map((v) => fmt(v, 2)).join(', ') + ']'
        : (k === sizes.length - 1 ? 'z = W·a + b，a = sigmoid(z)' : 'z = W·a + b，a = ' + state.cfg.activation);
      const vals = cache.A[k].slice(0, 6).map((v) =>
        '<span class="fwd-val" style="color:' + (v >= 0 ? '#dc2626' : '#2563eb') + '">' + fmt(v, 3) + '</span>').join('');
      const more = cache.A[k].length > 6 ? '<span class="fwd-val">…</span>' : '';
      out += '<div class="fwd-step' + (state.demoStep === k ? ' active' : '') + '"><h4>' + name + '</h4>' +
        '<div class="formula">' + formula + '</div><div class="fwd-vals">' + vals + more + '</div></div>';
    }
    els.forwardPanel.innerHTML = out;
  }

  function renderBoundary() {
    const canvas = els.boundaryCanvas, ctx = canvas.getContext('2d');
    const snap = current(), sizes = state.sizes, L = sizes.length;
    const S = 40, off = document.createElement('canvas');
    off.width = S; off.height = S;
    const octx = off.getContext('2d'), img = octx.createImageData(S, S);
    for (let gy = 0; gy < S; gy++) {
      for (let gx = 0; gx < S; gx++) {
        const x = -1.15 + 2.3 * gx / (S - 1);
        const y = 1.15 - 2.3 * gy / (S - 1);
        const p = forward(snap, [x, y], sizes, state.cfg.activation).A[L - 1][0];
        const c = p >= 0.5 ? [239, 68, 68] : [59, 130, 246];
        const a = 0.10 + 0.75 * Math.abs(p - 0.5) * 2;
        const idx = (gy * S + gx) * 4;
        img.data[idx] = Math.round(255 * (1 - a) + c[0] * a);
        img.data[idx + 1] = Math.round(255 * (1 - a) + c[1] * a);
        img.data[idx + 2] = Math.round(255 * (1 - a) + c[2] * a);
        img.data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(100,116,139,.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    const toPx = (v) => (v + 1.15) / 2.3 * canvas.width;
    for (let i = 0; i < state.data.X.length; i++) {
      const px = toPx(state.data.X[i][0]), py = canvas.height - toPx(state.data.X[i][1]);
      ctx.beginPath();
      ctx.arc(px, py, i === state.probeIndex ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = state.data.y[i] ? '#dc2626' : '#2563eb';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      if (i === state.probeIndex) {
        ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }

  function renderHeatmaps() {
    const snap = current();
    const htmlFor = (kind, title, matrix) => {
      let out = '<div class="maps">';
      for (let l = 0; l < matrix.length; l++) {
        const m = matrix[l];
        const max = maxAbs(m.flat());
        const cols = m[0].length;
        const cell = cols <= 2 ? 36 : (cols <= 4 ? 28 : (cols <= 8 ? 22 : 18));
        out += '<div class="map-block"><div class="map-title">' + layerName(l + 1) + ' · ' + title +
          ' (' + m.length + '×' + cols + ')</div><div class="heat-grid" style="grid-template-columns:repeat(' + cols + ',' + cell + 'px);grid-auto-rows:' + cell + 'px">';
        for (let i = 0; i < m.length; i++) {
          for (let j = 0; j < m[i].length; j++) {
            const v = m[i][j];
            const sel = state.selected.kind === kind && state.selected.l === l && state.selected.i === i && state.selected.j === j;
            const label = kind === 'W' ? 'W' : '∂L/∂W';
            out += '<div class="heat-cell' + (sel ? ' selected' : '') + '" style="background:' + colorFor(v, max) +
              '" data-kind="' + kind + '" data-l="' + l + '" data-i="' + i + '" data-j="' + j +
              '" title="' + label + SUP[l + 1] + '[' + i + ',' + j + '] = ' + fmt(v) + '"></div>';
          }
        }
        out += '</div><div class="map-hint">行 = 本层神经元 · 列 = 上一层</div></div>';
      }
      return out + '</div><div class="colorbar"><span>负</span><span class="bar"></span><span>正</span></div>';
    };
    els.weightMaps.innerHTML = htmlFor('W', '权重 W', snap.W);
    els.gradMaps.innerHTML = htmlFor('G', '梯度', snap.gW);
  }

  function renderBiasBars() {
    const snap = current();
    let out = '';
    for (let l = 0; l < snap.b.length; l++) {
      const vec = snap.b[l], max = maxAbs(vec);
      out += '<div class="bias-layer"><div class="bias-layer-title">' + layerName(l + 1) + ' · b</div>';
      for (let i = 0; i < vec.length; i++) {
        const v = vec[i], w = 50 * (max > 1e-12 ? Math.abs(v) / max : 0);
        const left = v >= 0 ? 50 : 50 - w;
        const sel = state.selected.kind === 'b' && state.selected.l === l && state.selected.i === i;
        out += '<div class="bias-row"><span class="bias-name">b' + (i + 1) + '</span><div class="bias-track">' +
          '<div class="bias-bar' + (sel ? ' selected' : '') + '" style="left:' + left + '%;width:' + w + '%;background:' + colorFor(v, max) +
          '" data-kind="b" data-l="' + l + '" data-i="' + i + '" title="' + layerName(l + 1) + ' b[' + i + '] = ' + fmt(v) + '"></div>' +
          '</div><span class="bias-val">' + fmt(v, 3) + '</span></div>';
      }
      out += '</div>';
    }
    els.biasBars.innerHTML = out;
  }

  function renderCharts() {
    const snaps = state.snaps;
    drawLineChart(els.lossChart, [{ values: snaps.map((s) => s.loss), color: '#4f46e5' }], {});
    drawLineChart(els.accChart, [{ values: snaps.map((s) => s.acc), color: '#059669' }], { ymin: 0, ymax: 1 });

    const palette = ['#4f46e5', '#0891b2', '#d97706'];
    const series = [];
    for (let l = 0; l < snaps[0].W.length; l++) {
      series.push({
        color: palette[l % palette.length],
        values: snaps.map((s) => {
          let sum = 0;
          s.gW[l].forEach((row) => row.forEach((g) => { sum += g * g; }));
          return state.cfg.lr * Math.sqrt(sum);
        })
      });
    }
    drawLineChart(els.deltaChart, series, {});
  }

  function selectedValue(snap) {
    const s = state.selected;
    if (s.kind === 'b') return { v: snap.b[s.l][s.i], g: snap.gb[s.l][s.i] };
    return { v: snap.W[s.l][s.i][s.j], g: snap.gW[s.l][s.i][s.j] };
  }

  function renderDetail() {
    const snap = current(), s = state.selected;
    const { v, g } = selectedValue(snap);
    const dv = -state.cfg.lr * g;
    const name = s.kind === 'b'
      ? 'b' + SUP[s.l + 1] + '[' + s.i + ']'
      : 'W' + SUP[s.l + 1] + '[' + s.i + ',' + s.j + ']';
    els.paramTitle.textContent = name + ' · ' + layerName(s.kind === 'b' ? s.l + 1 : s.l + 1);
    const sign = (x) => (x >= 0 ? '+' : '−');
    els.updateDetail.innerHTML =
      '<div class="kv">' +
      '<span class="k">当前参数值</span><span class="v">' + fmt(v, 5) + '</span>' +
      '<span class="k">梯度 ∂L/∂参数</span><span class="v">' + fmt(g, 5) + '</span>' +
      '<span class="k">学习率 η</span><span class="v">' + fmt(state.cfg.lr, 4) + '</span>' +
      '<span class="k">本次更新量 Δ = −η·g</span><span class="v ' + (dv >= 0 ? 'red' : 'blue') + '">' + sign(dv) + fmt(Math.abs(dv), 5) + '</span>' +
      '<span class="k">更新后参数值</span><span class="v">' + fmt(v + dv, 5) + '</span>' +
      '</div><div class="detail-note">展示第 ' + state.epoch + ' 轮的参数和梯度（更新前）。应用 Δ 后即进入第 ' + (state.epoch + 1) + ' 轮。' +
      (state.epoch === state.cfg.epochs ? '当前已是最后一轮，训练结束后不再执行更新。' : '') + '</div>';

    const values = state.snaps.map((sn) => {
      if (s.kind === 'b') return sn.b[s.l][s.i];
      return sn.W[s.l][s.i][s.j];
    });
    drawLineChart(els.weightTrajectory, [{ values: values, color: '#7c3aed' }], {});
  }

  function renderAll() {
    const snap = current();
    els.statEpoch.textContent = state.epoch + ' / ' + state.cfg.epochs;
    els.statLoss.textContent = fmt(snap.loss, 4);
    els.statAcc.textContent = (snap.acc * 100).toFixed(1) + '%';
    els.scrub.max = state.cfg.epochs;
    els.scrub.value = state.epoch;
    els.scrubOut.textContent = state.epoch;
    renderNetwork(); renderForward(); renderBoundary();
    renderHeatmaps(); renderBiasBars(); renderCharts(); renderDetail();
  }

  /* ==================== 交互 ==================== */

  function setStatus(text, cls) {
    els.statState.textContent = text;
    els.statState.className = 'badge' + (cls ? ' ' + cls : '');
  }

  function pause() {
    state.playing = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!els.statState.classList.contains('training')) setStatus('就绪');
    els.playBtn.textContent = '▶ 播放';
  }

  function setEpoch(e) {
    state.epoch = Math.max(0, Math.min(state.cfg.epochs, e));
    state.demoStep = -1;
    renderAll();
  }

  function tick() {
    if (!state.playing) return;
    if (state.epoch >= state.cfg.epochs) { pause(); return; }
    setEpoch(state.epoch + 1);
    state.timer = setTimeout(tick, 1000 / state.speed);
  }

  function togglePlay() {
    if (state.playing) { pause(); return; }
    if (state.epoch >= state.cfg.epochs) setEpoch(0);
    state.playing = true;
    setStatus('播放中', 'playing');
    els.playBtn.textContent = '❚❚ 暂停';
    tick();
  }

  function stopDemo() {
    if (state.demoTimer) { clearTimeout(state.demoTimer); state.demoTimer = null; }
    if (state.demoStep !== -1) { state.demoStep = -1; renderNetwork(); renderForward(); }
  }

  function startDemo() {
    stopDemo();
    state.demoStep = 0;
    renderNetwork(); renderForward();
    const step = () => {
      if (state.demoStep < state.sizes.length - 1) {
        state.demoStep++;
        renderNetwork(); renderForward();
        state.demoTimer = setTimeout(step, 550);
      } else {
        state.demoTimer = setTimeout(() => stopDemo(), 900);
      }
    };
    state.demoTimer = setTimeout(step, 550);
  }

  function readCfg() {
    state.cfg = {
      dataset: els.dataset.value,
      hiddenCount: +els.hiddenCount.value,
      hiddenSize: +els.hiddenSize.value,
      lr: Math.pow(10, -3 + (+els.lr.value / 100) * 2.7),
      epochs: +els.epochs.value,
      activation: els.activation.value
    };
    els.hiddenCountOut.textContent = state.cfg.hiddenCount;
    els.hiddenSizeOut.textContent = state.cfg.hiddenSize;
    els.lrOut.textContent = state.cfg.lr.toFixed(3);
    els.epochsOut.textContent = state.cfg.epochs;
  }

  function retrain() {
    pause();
    stopDemo();
    readCfg();
    setStatus('训练中…', 'training');
    // 先让浏览器有机会绘制"训练中"状态，再执行训练；不使用 requestAnimationFrame，
    // 避免页面处于后台或动画帧被节流时训练永远无法继续。
    setTimeout(() => {
      const result = train(state.cfg);
      state.snaps = result.snaps;
      state.sizes = result.sizes;
      state.data = result.data;
      state.epoch = 0;
      state.probeIndex = Math.min(state.probeIndex, result.data.X.length - 1);
      state.selected = { kind: 'W', l: 0, i: 0, j: 0 };
      els.scrub.max = state.cfg.epochs;
      setStatus('就绪');
      renderAll();
    }, 30);
  }

  function bindEvents() {
    ['dataset', 'hiddenCount', 'hiddenSize', 'lr', 'epochs', 'activation'].forEach((id) => {
      els[id].addEventListener('input', () => {
        els.hiddenCountOut.textContent = els.hiddenCount.value;
        els.hiddenSizeOut.textContent = els.hiddenSize.value;
        els.lrOut.textContent = Math.pow(10, -3 + (+els.lr.value / 100) * 2.7).toFixed(3);
        els.epochsOut.textContent = els.epochs.value;
      });
      els[id].addEventListener('change', retrain);
    });
    els.retrainBtn.addEventListener('click', retrain);
    els.playBtn.addEventListener('click', togglePlay);
    els.prevBtn.addEventListener('click', () => { pause(); setEpoch(state.epoch - 1); });
    els.nextBtn.addEventListener('click', () => { pause(); setEpoch(state.epoch + 1); });
    els.resetBtn.addEventListener('click', () => { pause(); setEpoch(0); });
    els.scrub.addEventListener('input', () => { pause(); setEpoch(+els.scrub.value); });
    els.speed.addEventListener('input', () => {
      state.speed = +els.speed.value;
      els.speedOut.textContent = state.speed + ' 轮/秒';
    });
    els.edgeMode.addEventListener('change', () => { state.edgeMode = els.edgeMode.value; renderNetwork(); });
    els.demoBtn.addEventListener('click', startDemo);

    const onPick = (e) => {
      const cell = e.target.closest('[data-kind]');
      if (!cell) return;
      state.selected = {
        kind: cell.dataset.kind, l: +cell.dataset.l, i: +cell.dataset.i,
        j: cell.dataset.j === undefined ? 0 : +cell.dataset.j
      };
      renderHeatmaps(); renderBiasBars(); renderDetail();
    };
    els.weightMaps.addEventListener('click', onPick);
    els.gradMaps.addEventListener('click', onPick);
    els.biasBars.addEventListener('click', onPick);

    els.boundaryCanvas.addEventListener('click', (e) => {
      const rect = els.boundaryCanvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * els.boundaryCanvas.width;
      const py = (e.clientY - rect.top) / rect.height * els.boundaryCanvas.height;
      let best = -1, bd = Infinity;
      state.data.X.forEach((pt, i) => {
        const x = (pt[0] + 1.15) / 2.3 * els.boundaryCanvas.width;
        const y = els.boundaryCanvas.height - (pt[1] + 1.15) / 2.3 * els.boundaryCanvas.height;
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) {
        state.probeIndex = best;
        renderNetwork(); renderForward(); renderBoundary();
      }
    });
  }

  /* ==================== 启动 ==================== */
  bindEvents();
  els.speedOut.textContent = state.speed + ' 轮/秒';
  retrain();
})();
