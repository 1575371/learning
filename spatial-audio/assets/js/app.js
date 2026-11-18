/* =========================================================
   app.js — 装配层
   · 生成界面控件（预设、声源列表、评分）
   · 绑定所有交互（含自由路径编辑、三维视角切换）
   · 实时读数与电平表
   · 主循环与启动
   ========================================================= */
(function (NS) {
  'use strict';
  const { $, clamp, state, PRESETS, MODE_LABEL, audio } = NS;

  const presetList = $('#presetList');
  const modeList = $('#modeList');
  const sourceList = $('#sourceList');

  /* =========================================================
     左侧：场景预设
     ========================================================= */
  function buildPresets() {
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.id = p.id;
      b.innerHTML = '<b>' + p.name + '</b><span>' + p.desc + '</span>';
      b.onclick = () => applyPreset(p);
      presetList.appendChild(b);
    });
  }

  function applyPreset(p) {
    state.preset = p.id;
    state.mode = p.mode;
    state.rt60 = p.rt60;
    state.wet = p.wet / 100;

    $('#rt60').value = p.rt60;
    $('#rt60Out').textContent = p.rt60.toFixed(1) + ' s';
    $('#wet').value = p.wet;
    $('#wetOut').textContent = p.wet + '%';

    for (const k in state.sources) {
      const s = state.sources[k];
      const cfg = p.src[k];
      if (!cfg) {
        s.muted = true;
        continue;
      }
      s.muted = false;
      s.x = cfg.x; s.z = cfg.z; s.y = cfg.y || 0;
      s.gain = cfg.gain;
      s.traj = JSON.parse(JSON.stringify(cfg.traj || { type: 'static' }));
    }

    if (!p.src[state.selected]) state.selected = Object.keys(p.src)[0];

    if (audio.ctx) NS.updateReverb();
    syncModes(); syncPresets(); syncSources(); syncSelection();
  }

  function syncPresets() {
    Array.from(presetList.children).forEach((b) => {
      b.classList.toggle('on', b.dataset.id === state.preset);
    });
  }

  /* =========================================================
     空间化模式
     ========================================================= */
  function syncModes() {
    Array.from(modeList.children).forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === state.mode);
    });
    $('#modeBadge').textContent = MODE_LABEL[state.mode];
    // FOA 的解码器有 9 个 HRTF 卷积器，第一次用到时才建
    if (state.mode === 'foa' && NS.prepareFoa) NS.prepareFoa();
  }

  modeList.addEventListener('click', (e) => {
    const b = e.target.closest('.mode');
    if (!b) return;
    state.mode = b.dataset.mode;
    syncModes();
  });

  /* =========================================================
     右侧：声源列表
     ========================================================= */
  function buildSources() {
    for (const k in state.sources) {
      const s = state.sources[k];
      const row = document.createElement('div');
      row.className = 'srcRow';
      row.dataset.key = k;
      row.innerHTML =
        '<span class="srcDot" style="background:' + s.def.color + '"></span>' +
        '<span class="srcName">' + s.def.name + '</span>' +
        '<span class="srcDist">—</span>' +
        '<button class="srcMute" title="静音 / 启用">ON</button>';

      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('srcMute')) {
          s.muted = !s.muted;
          syncSources(); syncSelection();
          return;
        }
        state.selected = k;
        syncSources(); syncSelection();
      });

      sourceList.appendChild(row);
    }
    $('#srcCount').textContent = Object.keys(state.sources).length;
  }

  function syncSources() {
    Array.from(sourceList.children).forEach((row) => {
      const s = state.sources[row.dataset.key];
      row.classList.toggle('on', row.dataset.key === state.selected);
      row.classList.toggle('off', s.muted);
      row.querySelector('.srcMute').textContent = s.muted ? 'OFF' : 'ON';
    });
  }

  /* =========================================================
     声源参数面板
     ========================================================= */
  const heightRange = $('#heightRange'), heightOut = $('#heightOut');
  const heightLabel = $('#heightLabel');
  const trajSel = $('#trajSel');
  const periodRange = $('#periodRange'), periodOut = $('#periodOut');
  const periodLabel = $('#periodLabel');
  const radiusWrap = $('#radiusWrap'), radiusRange = $('#radiusRange'), radiusOut = $('#radiusOut');
  const gainRange = $('#gainRange'), gainOut = $('#gainOut');
  const pathTools = $('#pathTools'), stageHint = $('#stageHint');
  const TOUCH = window.matchMedia('(pointer: coarse)').matches;
  const DEFAULT_HINT = TOUCH
    ? '拖动声源 · 拖空白处转视角 · 双指滑动页面'
    : '拖动声源 · 拖空白处转视角 · 滚轮缩放 · Shift+拖动改高度';

  function syncSelection() {
    const s = state.sources[state.selected];
    if (!s) return;

    $('#inspName').textContent = s.def.name;

    /* 高度始终显示基准值（路径模式下不跟着动画跳动） */
    heightRange.value = s.y.toFixed(1);
    heightOut.textContent = s.y.toFixed(1) + ' m';
    heightLabel.childNodes[0].nodeValue = s.traj.type === 'path' ? '路径高度' : '离地高度';

    trajSel.value = s.traj.type;
    const per = s.traj.period || (s.traj.type === 'orbit' ? 16 : s.traj.type === 'path' ? 20 : 6);
    periodRange.value = per;
    periodOut.textContent = per.toFixed(1) + ' s';

    periodLabel.childNodes[0].nodeValue =
      s.traj.type === 'orbit' ? '环绕周期' : s.traj.type === 'path' ? '走完全程' : '单程时长';

    radiusWrap.style.display = s.traj.type === 'orbit' ? 'block' : 'none';
    radiusRange.value = s.traj.radius || 2;
    radiusOut.textContent = (s.traj.radius || 2).toFixed(1) + ' m';

    gainRange.value = Math.round(s.gain * 100);
    gainOut.textContent = Math.round(s.gain * 100) + '%';

    /* 路径工具 */
    const isPath = s.traj.type === 'path';
    pathTools.style.display = isPath ? 'block' : 'none';
    if (isPath) {
      const n = (s.traj.pts || []).length;
      $('#pathClose').textContent = s.traj.closed ? '闭合中' : '未闭合';
      $('#pathClose').classList.toggle('on', !!s.traj.closed);
      $('#pathUndo').disabled = !n;
      stageHint.textContent = n
        ? '拖动节点改位置 · Shift+拖动改高度 · 双击节点删除 · 拖空白处转视角'
        : '点「＋ 加点」后在画面上点位置，至少 2 个点才会动起来';
    } else {
      stageHint.textContent = DEFAULT_HINT;
    }

    syncSources();
  }

  heightRange.addEventListener('input', () => {
    const s = state.sources[state.selected];
    const ny = parseFloat(heightRange.value);
    if (s.traj.type === 'path' && s.traj.pts) {
      const d = ny - s.y;
      s.traj.pts.forEach((p) => { p.y = clamp(p.y + d, 0, NS.ROOM_H - 0.2); });
    }
    s.y = ny;
    heightOut.textContent = s.y.toFixed(1) + ' m';
  });

  trajSel.addEventListener('change', () => {
    const s = state.sources[state.selected];
    const type = trajSel.value;
    const cur = s.p;

    if (type === 'static') {
      s.traj = { type: 'static' };
      s.x = cur.x; s.z = cur.z;
    } else if (type === 'line') {
      const a = 1.5;
      s.traj = {
        type: 'line',
        ax: clamp(cur.x - a, -NS.ROOM_HALF, NS.ROOM_HALF), az: clamp(cur.z, -NS.ROOM_HALF, NS.ROOM_HALF),
        bx: clamp(cur.x + a, -NS.ROOM_HALF, NS.ROOM_HALF), bz: clamp(cur.z, -NS.ROOM_HALF, NS.ROOM_HALF),
        period: 8
      };
    } else if (type === 'orbit') {
      s.traj = { type: 'orbit', radius: clamp(Math.hypot(cur.x, cur.z), 1, 4), period: 16 };
    } else {
      /* 自由路径：给一个可立即拖动的四边形，用户再随意增删 */
      const r = 1.4;
      s.traj = {
        type: 'path', closed: true, period: 20,
        pts: [
          { x: clamp(cur.x - r, -NS.ROOM_HALF, NS.ROOM_HALF), y: s.y, z: clamp(cur.z, -NS.ROOM_HALF, NS.ROOM_HALF) },
          { x: clamp(cur.x, -NS.ROOM_HALF, NS.ROOM_HALF), y: s.y, z: clamp(cur.z - r, -NS.ROOM_HALF, NS.ROOM_HALF) },
          { x: clamp(cur.x + r, -NS.ROOM_HALF, NS.ROOM_HALF), y: s.y, z: clamp(cur.z, -NS.ROOM_HALF, NS.ROOM_HALF) },
          { x: clamp(cur.x, -NS.ROOM_HALF, NS.ROOM_HALF), y: s.y, z: clamp(cur.z + r, -NS.ROOM_HALF, NS.ROOM_HALF) }
        ]
      };
    }
    NS.setEditMode(null);
    syncPathBtn();
    syncSelection();
  });

  periodRange.addEventListener('input', () => {
    const s = state.sources[state.selected];
    s.traj.period = parseFloat(periodRange.value);
    periodOut.textContent = s.traj.period.toFixed(1) + ' s';
  });

  radiusRange.addEventListener('input', () => {
    const s = state.sources[state.selected];
    s.traj.radius = parseFloat(radiusRange.value);
    radiusOut.textContent = s.traj.radius.toFixed(1) + ' m';
  });

  gainRange.addEventListener('input', () => {
    const s = state.sources[state.selected];
    s.gain = parseFloat(gainRange.value) / 100;
    gainOut.textContent = Math.round(s.gain * 100) + '%';
  });

  /* =========================================================
     自由路径工具
     ========================================================= */
  let adding = false;

  function syncPathBtn() {
    $('#pathAdd').classList.toggle('on', adding);
    $('#pathAdd').textContent = adding ? '点击画面落点…' : '＋ 加点';
  }

  $('#pathAdd').addEventListener('click', () => {
    const s = state.sources[state.selected];
    if (!s || s.traj.type !== 'path') return;
    adding = !adding;
    NS.setEditMode(adding ? 'add' : null);
    syncPathBtn();
  });

  $('#pathClose').addEventListener('click', () => {
    const s = state.sources[state.selected];
    if (!s || s.traj.type !== 'path') return;
    s.traj.closed = !s.traj.closed;
    syncSelection();
  });

  $('#pathUndo').addEventListener('click', () => {
    const s = state.sources[state.selected];
    if (!s || s.traj.type !== 'path' || !s.traj.pts) return;
    s.traj.pts.pop();
    syncSelection();
  });

  $('#pathClear').addEventListener('click', () => {
    const s = state.sources[state.selected];
    if (!s || s.traj.type !== 'path') return;
    s.traj.pts = [];
    syncSelection();
  });

  /* =========================================================
     距离与反射参数
     ========================================================= */
  const absorbRange = $('#absorbRange'), absorbOut = $('#absorbOut');
  const refLevelRange = $('#refLevelRange'), refLevelOut = $('#refLevelOut');
  const refDelayRange = $('#refDelayRange'), refDelayOut = $('#refDelayOut');
  const refDampRange = $('#refDampRange'), refDampOut = $('#refDampOut');

  absorbRange.addEventListener('input', () => {
    state.absorb = parseFloat(absorbRange.value) / 100;
    absorbOut.textContent = absorbRange.value + '%';
  });

  refLevelRange.addEventListener('input', () => {
    state.refLevel = parseFloat(refLevelRange.value) / 100;
    refLevelOut.textContent = refLevelRange.value + '%';
  });

  refDelayRange.addEventListener('input', () => {
    state.refDelayScale = parseFloat(refDelayRange.value) / 100;
    refDelayOut.textContent = state.refDelayScale.toFixed(1) + '×';
  });

  refDampRange.addEventListener('input', () => {
    state.refDamp = parseFloat(refDampRange.value) / 100;
    refDampOut.textContent = refDampRange.value + '%';
  });

  /* 折叠块展开后比面板还高，展开时把面板滚到它的顶部，
     否则点开只能看到第一行 */
  function scrollBlockIntoView(blockSel, panelSel) {
    const panel = $(panelSel), block = $(blockSel);
    if (!panel || !block) return;
    panel.scrollTop += block.getBoundingClientRect().top
      - panel.getBoundingClientRect().top - 6;
  }
  $('#distBlock').addEventListener('toggle', (e) => {
    if (e.target.open) scrollBlockIntoView('#distBlock', '#leftPanel');
  });
  $('#rateBlock').addEventListener('toggle', (e) => {
    if (e.target.open) scrollBlockIntoView('#rateBlock', '#rightPanel');
  });

  /* =========================================================
     房间声学与总音量
     ========================================================= */
  $('#rt60').addEventListener('input', (e) => {
    state.rt60 = parseFloat(e.target.value);
    $('#rt60Out').textContent = state.rt60.toFixed(1) + ' s';
    NS.updateReverb();
  });

  $('#wet').addEventListener('input', (e) => {
    state.wet = parseFloat(e.target.value) / 100;
    $('#wetOut').textContent = e.target.value + '%';
    NS.updateReverb();
  });

  $('#master').addEventListener('input', (e) => {
    state.master = parseFloat(e.target.value) / 100;
    $('#masterOut').textContent = e.target.value + '%';
    NS.applyMaster();
  });

  /* =========================================================
     三维视角
     ========================================================= */
  const VIEW_YAW = { oblique: 0.58, top: 0.0, side: Math.PI / 2 };
  const VIEW_PITCH = { oblique: 0.50, top: 1.40, side: 0.22 };

  function syncCamera() {
    const c = NS.camera;
    document.querySelectorAll('.camBtn[data-cam]').forEach((b) => {
      b.classList.toggle('on', !c.spin && Math.abs(c.pitch - VIEW_PITCH[b.dataset.cam]) < 0.15
        && Math.abs(Math.atan2(Math.sin(c.yaw - VIEW_YAW[b.dataset.cam]), Math.cos(c.yaw - VIEW_YAW[b.dataset.cam]))) < 0.25);
    });
    $('#camSpin').classList.toggle('on', c.spin);
  }

  NS.syncCamUi = syncCamera;

  document.querySelectorAll('.camBtn[data-cam]').forEach((b) => {
    b.addEventListener('click', () => {
      NS.setView(b.dataset.cam);
      adding = false;
      NS.setEditMode(null);
      syncPathBtn();
      syncCamera();
    });
  });

  $('#camSpin').addEventListener('click', () => {
    NS.camera.spin = !NS.camera.spin;
    syncCamera();
  });

  /* =========================================================
     A/B 对照试听：每 3.8 秒切一种表示
     ========================================================= */
  const AB_ORDER = ['mono', 'stereo', 'model', 'hrtf', 'foa'];   // 与表示演进一致
  let abTimer = null, abIdx = 0;

  $('#abBtn').addEventListener('click', async () => {
    const btn = $('#abBtn');
    if (abTimer) {
      clearInterval(abTimer); abTimer = null;
      btn.classList.remove('on');
      btn.textContent = 'A/B 对照试听';
      hideToast();
      return;
    }
    if (!audio.ctx) await startAudio();
    btn.classList.add('on');
    btn.textContent = '停止对照';
    abIdx = 0;
    stepAB();
    abTimer = setInterval(stepAB, 3800);
  });

  function stepAB() {
    state.mode = AB_ORDER[abIdx % AB_ORDER.length];
    abIdx++;
    syncModes();
    showToast(MODE_LABEL[state.mode]);
  }

  let toastT = null;
  function showToast(txt) {
    const el = $('#abToast');
    el.textContent = txt;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(hideToast, 2000);
  }
  function hideToast() { $('#abToast').classList.remove('show'); }

  /* =========================================================
     播放控制
     浏览器要求一次用户手势后才能出声，所以首次播放由按钮触发。
     真实录音在页面加载时就开始解码（不需要手势），点击时通常已经就绪；
     万一还没解完，这里会等它一下，绝不阻塞界面。
     ========================================================= */
  let starting = null;

  function startAudio() {
    if (starting) return starting;
    starting = (async () => {
      if (!audio.ctx) {
        if (!audio.samples && NS.samplePromise) {
          try { audio.samples = await NS.samplePromise; } catch (e) { /* 回退到合成 */ }
        }
        NS.initAudio();
      }
      if (audio.ctx.state === 'suspended') audio.ctx.resume();
      audio.playing = true;
      state.running = true;

      initEvalAnalysers();
      if (state.mode === 'foa') NS.prepareFoa();

      $('#startOverlay').classList.add('hide');
      const b = $('#playBtn');
      b.textContent = '静音';
      b.classList.add('on');
    })().finally(() => { starting = null; });
    return starting;
  }

  $('#startBtn').addEventListener('click', startAudio);

  $('#playBtn').addEventListener('click', () => {
    if (!audio.ctx) { startAudio(); return; }
    if (audio.ctx.state === 'running') {
      audio.ctx.suspend();
      state.running = false;
      $('#playBtn').textContent = '恢复';
      $('#playBtn').classList.remove('on');
    } else {
      audio.ctx.resume();
      state.running = true;
      $('#playBtn').textContent = '静音';
      $('#playBtn').classList.add('on');
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (e.code === 'Escape' && adding) {
      adding = false; NS.setEditMode(null); syncPathBtn();
      return;
    }
    if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'BUTTON') {
      e.preventDefault();
      $('#playBtn').click();
    }
  });

  /* =========================================================
     主观听评
     ========================================================= */
  const RATE_DIMS = [
    { key: 'natural', label: '自然度' },
    { key: 'match', label: '符合度' },
    { key: 'space', label: '空间感' }
  ];
  const scores = { natural: 0, match: 0, space: 0 };
  const rateRows = $('#rateRows');
  const RKEY = 'sa-lab-ratings-v1';

  function buildRatings() {
    RATE_DIMS.forEach((dim) => {
      const row = document.createElement('div');
      row.className = 'rateRow';
      let html = '<span>' + dim.label + '</span><div class="stars">';
      for (let i = 1; i <= 5; i++) {
        html += '<button class="star" data-dim="' + dim.key + '" data-v="' + i + '">' + i + '</button>';
      }
      row.innerHTML = html + '</div>';
      rateRows.appendChild(row);
    });

    rateRows.addEventListener('click', (e) => {
      const b = e.target.closest('.star');
      if (!b) return;
      const dim = b.dataset.dim;
      scores[dim] = parseInt(b.dataset.v, 10);
      Array.from(rateRows.querySelectorAll('.star[data-dim="' + dim + '"]')).forEach((x) => {
        x.classList.toggle('on', parseInt(x.dataset.v, 10) <= scores[dim]);
      });
    });
  }

  function loadRatings() {
    try { return JSON.parse(localStorage.getItem(RKEY) || '[]'); } catch (e) { return []; }
  }

  $('#rateSubmit').addEventListener('click', () => {
    if (!scores.natural || !scores.match || !scores.space) {
      $('#rateStats').textContent = '请把三项都打分后再记录。';
      return;
    }
    const list = loadRatings();
    list.push({
      n: scores.natural, m: scores.match, s: scores.space,
      mode: state.mode, preset: state.preset, t: Date.now()
    });
    try { localStorage.setItem(RKEY, JSON.stringify(list.slice(-60))); } catch (e) { /* 隐私模式下忽略 */ }
    renderRatings();
    showToast('已记录：' + MODE_LABEL[state.mode]);
  });

  function renderRatings() {
    const list = loadRatings();
    const el = $('#rateStats');
    const badge = $('#rateCount');
    if (badge) badge.textContent = list.length + ' 次';
    if (!list.length) { el.textContent = '还没有记录。'; return; }
    const avg = (k) => (list.reduce((a, b) => a + b[k], 0) / list.length).toFixed(2);
    el.innerHTML = '已记录 <b style="color:#ffb457">' + list.length + '</b> 次 · 自然度 ' + avg('n')
      + ' / 符合度 ' + avg('m') + ' / 空间感 ' + avg('s');
  }

  /* =========================================================
     客观评测
     · ITD 误差：从**输出**的左右声道互相关实测时间差，与设定值比较
     · FOA 方位误差：从 W/X/Y/Z 的有功声强矢量算方向，与设定方位比较
     · 扩散度：1 − |I|/E，声源分散时升高
     这三个量都能在浏览器里实时算，不需要训练模型或参考数据集。
     ========================================================= */
  let foaAn = null;
  const bufL2 = new Float32Array(2048), bufR2 = new Float32Array(2048);
  const foaBuf = [];
  /* 声强矢量与 ITD 都做指数平滑：单帧估计在瞬态声源上会跳 */
  const foaSm = { x: 0, y: 0, z: 0, w: 0 };
  let itdSm = null;

  function initEvalAnalysers() {
    if (!audio.ctx || foaAn) return;
    audio.anL.fftSize = 2048;          // 互相关需要更长窗口
    audio.anR.fftSize = 2048;
    foaAn = audio.foa.ch.map((ch, i) => {
      const a = audio.ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0.2;
      ch.connect(a);
      foaBuf[i] = new Float32Array(2048);
      return a;
    });
  }

  function measureItd() {
    if (!audio.ctx || audio.ctx.state !== 'running') return null;
    audio.anL.getFloatTimeDomainData(bufL2);
    audio.anR.getFloatTimeDomainData(bufR2);
    const N = bufL2.length, guard = 64;
    let best = -1, lagBest = 0;
    for (let lag = -48; lag <= 48; lag++) {
      let num = 0, dl = 0, dr = 0;
      for (let i = guard; i < N - guard; i++) {
        const a = bufL2[i], b = bufR2[i + lag];
        num += a * b; dl += a * a; dr += b * b;
      }
      const r = num / (Math.sqrt(dl * dr) + 1e-12);
      if (r > best) { best = r; lagBest = lag; }
    }
    if (best < 0.72) { itdSm = null; return null; } // 多源/混响下互相关不可靠，不出数
    const us = -lagBest / audio.ctx.sampleRate * 1e6;
    itdSm = itdSm === null ? us : itdSm + (us - itdSm) * 0.3;
    return { us: itdSm, r: best };
  }

  function measureFoa() {
    if (!foaAn) return null;
    foaAn.forEach((a, i) => a.getFloatTimeDomainData(foaBuf[i]));
    let wx = 0, wy = 0, wz = 0, ww = 0;
    const N = foaBuf[0].length;
    for (let i = 0; i < N; i++) {
      const w = foaBuf[0][i], x = foaBuf[1][i], y = foaBuf[2][i], z = foaBuf[3][i];
      wx += w * x; wy += w * y; wz += w * z; ww += w * w;
    }
    if (ww < 1e-8) return null;
    const k = 0.25;
    foaSm.x += (wx - foaSm.x) * k;
    foaSm.y += (wy - foaSm.y) * k;
    foaSm.z += (wz - foaSm.z) * k;
    foaSm.w += (ww - foaSm.w) * k;
    if (foaSm.w < 1e-8) return null;
    /* 声强矢量换成世界方向：AmbiX 的 (X 前, Y 左, Z 上) → 世界 (x, y, z)
       即 (-Y, Z, -X)。用三维方向算角度误差，避免声源接近头顶时
       方位角因仰角过大而发散。 */
    const mag = Math.hypot(foaSm.x, foaSm.y, foaSm.z) || 1e-9;
    const dir = { x: -foaSm.y / mag, y: foaSm.z / mag, z: -foaSm.x / mag };
    const strength = Math.min(1, mag / foaSm.w / 1.4142);
    return { dir, diff: 1 - strength };
  }

  /**
   * 找出「主导声源」：能量占比 ≥ 75% 的那个。
   * ITD 误差与 FOA 方位误差都只在单一声源占主导时才有确定的目标值——
   * 多源叠加时"应该有"的 ITD / 方位本身就不唯一（各声源的 RMS 差很多，
   * 光按增益推算会给出看起来精确的错值）。这种情况直接标"多源"，不出数。
   */
  function dominantSource() {
    let best = null, bestW = 0, sumW = 0;
    for (const k in state.sources) {
      const s = state.sources[k];
      if (s.muted || !s.cues) continue;
      const amp = s.gain / (1 + 0.5 * Math.max(0, s.cues.d - 1));
      const w = amp * amp;
      sumW += w;
      if (w > bestW) { bestW = w; best = s; }
    }
    return (best && sumW > 1e-9 && bestW >= sumW * 0.75) ? best : null;
  }

  const wrap180 = (d) => ((d + 540) % 360) - 180;

  /* =========================================================
     底部读数：方位 / 距离 / ITD / ILD / FOA / 电平
     ========================================================= */
  function updateReadouts() {
    const s = state.sources[state.selected];
    if (!s || !s.cues) return;
    const c = s.cues;

    $('#mAz').textContent = (c.azDeg >= 0 ? '右 ' : '左 ') + Math.abs(c.azDeg).toFixed(1) + '°';
    $('#mEl').textContent = (c.elDeg >= 0 ? '+' : '') + c.elDeg.toFixed(1) + '°';
    $('#mDist').textContent = c.d.toFixed(2) + ' m';
    $('#mItd').textContent = (c.itdMs * 1000).toFixed(0) + ' µs';
    $('#mIld').textContent = Math.abs(c.ildDb).toFixed(1) + ' dB';

    $('#cueItd').textContent = (c.itdMs * 1000).toFixed(0) + ' µs';
    $('#cueIld').textContent = Math.abs(c.ildDb).toFixed(1) + ' dB';
    $('#itdSide').textContent = c.itdMs < 0.01
      ? '声源在正中，两耳同时到达。'
      : (c.rightLeads ? '右耳先到 ' : '左耳先到 ') + (c.itdMs * 1000).toFixed(0)
        + ' µs，右耳声级差 ' + (c.ildDb > 0 ? '+' : '') + c.ildDb.toFixed(1) + ' dB。';

    // 两耳增益条（按较大一侧归一化）
    const mx = Math.max(c.gL, c.gR, 0.001);
    $('#earL').style.width = (c.gL / mx * 100).toFixed(0) + '%';
    $('#earR').style.width = (c.gR / mx * 100).toFixed(0) + '%';

    // 距离与反射读数：D/R 是判断远近的主要线索，做成实时数值
    if (s.refl && s.air) {
      const drDb = NS.drOf(s);
      const delayMs = s.refl.delay * state.refDelayScale * 1000;
      const txt = (drDb > 0 ? '+' : '') + drDb.toFixed(0) + ' dB';
      const tag = $('#drTag');
      tag.textContent = 'D/R ' + txt;
      tag.style.color = drDb > -6 ? 'var(--amber)' : '';
      $('#mDr').textContent = txt;
      $('#distNote').textContent =
        '反射 ' + delayMs.toFixed(1) + ' ms · 高频截止 ' + (s.air.cut / 1000).toFixed(1) + ' kHz';
    }

    /* ---- 客观评测：ITD 误差 + FOA 方位误差 + 扩散度 ---- */
    const dom = dominantSource();
    const itd = measureItd();
    const tag = $('#evalTag');

    if (itd && dom) {
      $('#eItd').textContent = (itd.us >= 0 ? '+' : '') + itd.us.toFixed(0) + ' µs';
      const c2 = dom.cues;
      const targetUs = c2.itdMs * 1000 * (c2.rightLeads ? 1 : -1);
      const err = itd.us - targetUs;
      $('#eItdErr').textContent = (err >= 0 ? '+' : '') + err.toFixed(0) + ' µs';
      $('#eItdErr').style.color = Math.abs(err) > 150 ? 'var(--amber)' : '';
      tag.textContent = 'ITD 误差 ' + (err >= 0 ? '+' : '') + err.toFixed(0) + ' µs';
      tag.style.color = Math.abs(err) > 150 ? 'var(--amber)' : '';
    } else {
      /* 多源或信号太弱时，互相关峰位不再对应某个声源的 ITD，不出数 */
      $('#eItd').textContent = '多源';
      $('#eItdErr').textContent = '多源';
      tag.textContent = '多源场景';
      tag.style.color = 'var(--dim2)';
    }

    const foaM = measureFoa();
    if (foaM) {
      $('#eDiff').textContent = foaM.diff.toFixed(2);
      if (dom) {
        const c3 = dom.cues;
        const a = c3.azDeg * Math.PI / 180, e3 = c3.elDeg * Math.PI / 180;
        const t = { x: Math.sin(a) * Math.cos(e3), y: Math.sin(e3), z: -Math.cos(a) * Math.cos(e3) };
        const dot = Math.max(-1, Math.min(1,
          t.x * foaM.dir.x + t.y * foaM.dir.y + t.z * foaM.dir.z));
        const ang = Math.acos(dot) * 180 / Math.PI;
        $('#eFoa').textContent = ang.toFixed(1) + '°';
        $('#eFoa').style.color = ang > 12 ? 'var(--amber)' : '';
      } else {
        $('#eFoa').textContent = '多源';
        $('#eFoa').style.color = 'var(--dim2)';
      }
    } else {
      $('#eFoa').textContent = '—';
      $('#eDiff').textContent = '—';
    }

    // FOA 编码（AmbiX：X 前 / Y 左 / Z 上，W 为全向分量）
    let W = 0, X = 0, Y = 0, Z = 0;
    for (const k in state.sources) {
      const src = state.sources[k];
      if (src.muted || !src.cues) continue;
      const cc = src.cues;
      const a = cc.azDeg * Math.PI / 180, e = cc.elDeg * Math.PI / 180;
      const g2 = (1 / (1 + 0.5 * Math.max(0, cc.d - 1))) * src.gain;
      W += 0.707 * g2;
      X += g2 * Math.cos(a) * Math.cos(e);
      Y += -g2 * Math.sin(a) * Math.cos(e);
      Z += g2 * Math.sin(e);
    }
    const peak = Math.max(W, Math.abs(X), Math.abs(Y), Math.abs(Z), 0.001);
    setUni($('#foaW'), W / peak);
    setBi($('#foaX'), X / peak);
    setBi($('#foaY'), Y / peak);
    setBi($('#foaZ'), Z / peak);

    // 声源列表里的距离
    Array.from(sourceList.children).forEach((row) => {
      const src = state.sources[row.dataset.key];
      const dEl = row.querySelector('.srcDist');
      if (dEl && src.cues) dEl.textContent = src.cues.d.toFixed(1) + 'm';
    });
  }

  function setUni(el, v) {
    el.style.left = '0%';
    el.style.width = clamp(v, 0, 1) * 100 + '%';
  }
  function setBi(el, v) {
    const w = Math.abs(clamp(v, -1, 1)) * 50;
    el.style.width = w + '%';
    el.style.left = (v >= 0 ? 50 : 50 - w) + '%';
  }

  /* 电平表：峰值保持 + 衰减，避免打击类声源之间跳成 0 */
  const bufL = new Float32Array(256), bufR = new Float32Array(256);
  let peakL = 0, peakR = 0;

  function toW(v) {
    return clamp(Math.sqrt(v) * 240, 0, 100).toFixed(0) + '%';
  }

  function updateLevels() {
    if (!audio.ctx || audio.ctx.state !== 'running') {
      peakL *= 0.82; peakR *= 0.82;
      $('#lvlL').style.width = toW(peakL);
      $('#lvlR').style.width = toW(peakR);
      return;
    }
    audio.anL.getFloatTimeDomainData(bufL);
    audio.anR.getFloatTimeDomainData(bufR);
    const rms = (b) => {
      let sum = 0;
      for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
      return Math.sqrt(sum / b.length);
    };
    peakL = Math.max(rms(bufL), peakL * 0.90);
    peakR = Math.max(rms(bufR), peakR * 0.90);
    $('#lvlL').style.width = toW(peakL);
    $('#lvlR').style.width = toW(peakR);
  }

  /* =========================================================
     主循环
     ========================================================= */
  let frame = 0;

  function loop(now) {
    state.time = now / 1000;
    NS.computeScene();
    if (audio.ctx && state.running) NS.updateVoices();
    NS.draw();

    if (frame % 4 === 0) updateReadouts();
    if (frame % 4 === 2) updateLevels();
    frame++;

    requestAnimationFrame(loop);
  }

  /* =========================================================
     启动
     ========================================================= */
  function boot() {
    buildPresets();
    buildSources();
    buildRatings();
    renderRatings();

    /* 页面一加载就开始解码内嵌录音，用户点"开始试听"时基本已就绪 */
    if (NS.loadSamples) NS.samplePromise = NS.loadSamples();

    NS.resize();
    new ResizeObserver(NS.resize).observe($('#stage'));

    applyPreset(PRESETS[0]);
    syncModes(); syncPresets(); syncSources(); syncSelection(); syncCamera();
    syncPathBtn();

    requestAnimationFrame(loop);
  }

  Object.assign(NS, { syncSelection, syncSources, syncModes, applyPreset, startAudio, showToast, syncCamUi: syncCamera });

  boot();
})(window.SALab);
