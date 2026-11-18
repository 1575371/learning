/* =========================================================
   engine.js — Web Audio 音频图（路线一：先有声音，再空间化）

   每个声源同时保留 4 条并行支路，用增益开关切换，避免重建节点产生爆音：

        BufferSource ──▶ vol ─┬─▶ tapMono ───────────────────────▶ bus
                              ├─▶ Panner(equalpower) ▶ tapSt ────▶ bus
                              ├─▶ Panner(HRTF)       ▶ tapHr ────▶ bus
                              └─▶ gL/gR ▶ Delay ▶ Lowpass ▶ Merger
                                                        ▶ tapMd ─▶ bus

        bus ─┬─▶ dry ─────────────────┐
             └─▶ Convolver ▶ wet ─────┴─▶ master ▶ Compressor ▶ destination

   HRTF 用浏览器内置的实测 HRIR；「双耳 · 模型」用 spatial.js 算出的
   ILD / ITD / 头部遮蔽，自己搭链路，便于把中间量显示在界面上。
   ========================================================= */
(function (NS) {
  'use strict';
  const { state, clamp } = NS;

  const audio = {
    ctx: null,
    buffers: {},
    samples: null,          // 解码后的真实录音（samples.js），失败则为 null
    bus: null, dry: null, wet: null, conv: null, master: null,
    splitter: null, anL: null, anR: null,
    foa: null,              // 一阶 Ambisonics：4 条编码通道 + 解码出口
    voices: [],
    playing: false
  };

  /* =========================================================
     真实录音的载入
     优先用 assets/js/samples.js 里内嵌的两段录音；解码失败时
     自动回退到 synth.js 的实时合成，功能不受影响。
     ========================================================= */

  /** 立体声 → 单声道 */
  function toMono(buf) {
    const n = buf.length, ch = buf.numberOfChannels;
    if (ch === 1) return Float32Array.from(buf.getChannelData(0));
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const x = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += x[i] / ch;
    }
    return out;
  }

  /** 采样率转换（线性插值）——录音是 48 kHz，多数设备也是 */
  function resampleLinear(d, from, to) {
    if (from === to) return d;
    const n = Math.floor(d.length * to / from);
    const out = new Float32Array(n);
    const r = from / to;
    for (let i = 0; i < n; i++) {
      const x = i * r, i0 = Math.floor(x), t = x - i0;
      const a = d[i0] || 0, b = d[i0 + 1] || 0;
      out[i] = a + (b - a) * t;
    }
    return out;
  }

  /** 简单变速（同时改变音高，用来模拟同一只狗不同力度的吠叫） */
  function pitchShift(d, factor) {
    const n = Math.floor(d.length / factor);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * factor, i0 = Math.floor(x), t = x - i0;
      const a = d[i0] || 0, b = d[i0 + 1] || 0;
      out[i] = a + (b - a) * t;
    }
    return out;
  }

  /**
   * 把"两声一组的犬吠"拼成一条 6.4 s 的循环：
   * 三组之间留不同的间隔（0 / 0.35 / 0.9 s）、做 -3% / +2.8% 的音高微差、
   * 音量也略有起伏。这样循环起来是"汪 汪 …… 汪 汪"的自然节奏，
   * 而不是每 1.6 s 精确重复一次。
   */
  function buildBarkLoop(data, sr) {
    const GROUPS = [
      { f: 1.000, g: 1.00, gap: 0.00 },
      { f: 0.970, g: 0.94, gap: 0.35 },
      { f: 1.028, g: 0.97, gap: 0.90 }
    ];
    const parts = GROUPS.map((g) => ({
      d: g.f === 1 ? data : pitchShift(data, g.f),
      g: g.g,
      gap: Math.floor(g.gap * sr)
    }));
    const total = parts.reduce((a, p) => a + p.gap + p.d.length, 0) + Math.floor(0.25 * sr);
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      o += p.gap;
      for (let i = 0; i < p.d.length && o + i < total; i++) out[o + i] = p.d[i] * p.g;
      o += p.d.length;
    }
    return out;
  }

  /** 解码内嵌录音；返回 { dog:{data,sr}, steps:{data,sr} } 或 null */
  async function loadSamples() {
    if (!NS.SAMPLE_MP3) return null;
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const tmp = new OAC(1, 1, 48000);
      const out = {};
      for (const k in NS.SAMPLE_MP3) {
        const ab = await (await fetch(NS.SAMPLE_MP3[k])).arrayBuffer();
        const buf = await tmp.decodeAudioData(ab);
        out[k] = { data: toMono(buf), sr: buf.sampleRate };
      }
      if (out.bark) out.bark = { data: buildBarkLoop(out.bark.data, out.bark.sr), sr: out.bark.sr };
      return out;
    } catch (e) {
      console.warn('[samples] 录音解码失败，改用实时合成：', e);
      return null;
    }
  }

  /** 某个声源最终用哪段波形：优先真实录音，否则合成 */
  function soundData(key, sr) {
    const s = audio.samples && audio.samples[key];
    if (s && s.data && s.data.length) return resampleLinear(s.data, s.sr, sr);
    return NS.SYNTH[key](sr);
  }

  /* ---------------- 建立整张图 ---------------- */
  function initAudio() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    audio.ctx = ctx;

    /* 母带链 */
    audio.bus = ctx.createGain();
    audio.dry = ctx.createGain();
    audio.wet = ctx.createGain();
    audio.conv = ctx.createConvolver();
    audio.master = ctx.createGain();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 3.2;
    comp.attack.value = 0.004; comp.release.value = 0.22;

    audio.bus.connect(audio.dry); audio.dry.connect(audio.master);
    audio.bus.connect(audio.conv); audio.conv.connect(audio.wet); audio.wet.connect(audio.master);
    audio.master.connect(comp); comp.connect(ctx.destination);

    /* 电平表：把总线拆成 L/R 两路做 RMS 读数 */
    audio.splitter = ctx.createChannelSplitter(2);
    audio.anL = ctx.createAnalyser();
    audio.anR = ctx.createAnalyser();
    audio.anL.fftSize = 256; audio.anR.fftSize = 256;
    audio.bus.connect(audio.splitter);
    audio.splitter.connect(audio.anL, 0);
    audio.splitter.connect(audio.anR, 1);

    /* 听者：站在原点，耳平面高度 EAR_H，朝向 -Z */
    const L = ctx.listener;
    const eh = NS.EAR_H;
    if (L.positionX) {
      L.positionX.value = 0; L.positionY.value = eh; L.positionZ.value = 0;
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(0, eh, 0);
      L.setOrientation(0, 0, -1, 0, 1, 0);
    }

    /* ========== 一阶 Ambisonics 的四个编码通道（AmbiX） ==========
       W 全向 / X 前 / Y 左 / Z 上。这只是中间信号，不直接出声——
       必须经过解码器还原成双耳信号才能听，这正是论文里说的
       「FOA 需按播放设备解码」。解码器在第一次切到 FOA 时才建（见 prepareFoa）。 */
    audio.foa = {
      ch: [ctx.createGain(), ctx.createGain(), ctx.createGain(), ctx.createGain()],
      tap: ctx.createGain(),
      sm: 0
    };
    audio.foa.tap.gain.value = 0;
    audio.foa.tap.connect(audio.bus);

    /* 逐一声源准备波形：狗叫与脚步用真实录音，其余实时合成 */    for (const k in NS.SYNTH) {
      const data = soundData(k, ctx.sampleRate);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data, 0);
      audio.buffers[k] = buf;
    }

    /* 为每个声源搭 4 条支路 + 距离滤波 + 一次反射 */
    for (const k in state.sources) {
      const s = state.sources[k];

      const bs = ctx.createBufferSource();
      bs.buffer = audio.buffers[s.def.sound];
      bs.loop = true;
      bs.loopStart = 0;
      bs.loopEnd = bs.buffer.duration;

      const vol = ctx.createGain();
      vol.gain.value = 0;
      bs.connect(vol);

      /* ---- 距离滤波：空气吸收，四种模式共用 ----
         放在分叉之前，这样"单声道"也能听出远近（只有音量变化的远近是
         最弱的距离线索）。Q 取 0.4，斜缓，避免把声音压成闷罐。 */
      const distLP = ctx.createBiquadFilter();
      distLP.type = 'lowpass';
      distLP.frequency.value = 20000;
      distLP.Q.value = 0.4;
      const distShelf = ctx.createBiquadFilter();
      distShelf.type = 'highshelf';
      distShelf.frequency.value = 3200;
      distShelf.gain.value = 0;
      vol.connect(distLP); distLP.connect(distShelf);

      // 1) 单声道
      const tapMono = ctx.createGain(); tapMono.gain.value = 0;
      distShelf.connect(tapMono); tapMono.connect(audio.bus);

      // 2) 立体声：只有左右强弱差
      const pSt = mkPanner(ctx, 'equalpower');
      const tapSt = ctx.createGain(); tapSt.gain.value = 0;
      distShelf.connect(pSt); pSt.connect(tapSt); tapSt.connect(audio.bus);

      // 3) 双耳 · HRTF
      const pHr = mkPanner(ctx, 'HRTF');
      const tapHr = ctx.createGain(); tapHr.gain.value = 0;
      distShelf.connect(pHr); pHr.connect(tapHr); tapHr.connect(audio.bus);

      // 4) 双耳 · 模型：每耳 = 增益 × 延时 × 低通
      const gL = ctx.createGain(), gR = ctx.createGain();
      const dL = ctx.createDelay(0.02), dR = ctx.createDelay(0.02);
      const fL = ctx.createBiquadFilter(), fR = ctx.createBiquadFilter();
      fL.type = fR.type = 'lowpass';
      fL.frequency.value = fR.frequency.value = 18000;
      fL.Q.value = fR.Q.value = 0.5;

      const merger = ctx.createChannelMerger(2);
      const tapMd = ctx.createGain(); tapMd.gain.value = 0;

      distShelf.connect(gL); gL.connect(dL); dL.connect(fL); fL.connect(merger, 0, 0);
      distShelf.connect(gR); gR.connect(dR); dR.connect(fR); fR.connect(merger, 0, 1);
      merger.connect(tapMd); tapMd.connect(audio.bus);

      /* ---- 一次反射（镜像声源） ----
         distShelf → Delay（几何路径差） → Lowpass（墙面吸声） → Gain（D/R）
                   ├→ tapRefM（单声道模式：不分方位）
                   └→ Panner(equalpower, 位于镜像点) → tapRefS */

      const refDelay = ctx.createDelay(0.16);
      refDelay.delayTime.value = 0.012;
      const refLP = ctx.createBiquadFilter();
      refLP.type = 'lowpass';
      refLP.frequency.value = 9000;
      refLP.Q.value = 0.5;
      const refGain = ctx.createGain();
      refGain.gain.value = 0;

      /* rolloffFactor = 0：反射的距离衰减由 refGain 按自己的规律算，
         不能让 Panner 再按直达声的 1/r 衰减一次，否则远距离 D/R 反而下降 */
      const refPan = ctx.createPanner();
      refPan.panningModel = 'equalpower';
      refPan.distanceModel = 'inverse';
      refPan.refDistance = 1;
      refPan.rolloffFactor = 0;
      refPan.maxDistance = 1000;
      refPan.coneInnerAngle = 360;

      const tapRefM = ctx.createGain(); tapRefM.gain.value = 0;
      const tapRefS = ctx.createGain(); tapRefS.gain.value = 0;
      tapRefM.connect(audio.bus);
      tapRefS.connect(audio.bus);

      distShelf.connect(refDelay);
      refDelay.connect(refLP);
      refLP.connect(refGain);
      refGain.connect(tapRefM);
      refGain.connect(refPan);
      refPan.connect(tapRefS);

      /* ---- FOA 编码：把这条声源按方位写成 W/X/Y/Z 四个分量 ----
         系数每帧按声源方向重算，四条支路各自加进对应的通道总线。 */
      const foaTaps = [0, 1, 2, 3].map((i) => {
        const g = ctx.createGain();
        g.gain.value = 0;
        distShelf.connect(g);
        g.connect(audio.foa.ch[i]);
        return g;
      });

      s._v = {
        bs, vol, tapMono, tapSt, tapHr, tapMd, pSt, pHr, gL, gR, dL, dR, fL, fR,
        distLP, distShelf, refDelay, refLP, refGain, refPan, tapRefM, tapRefS, foa: foaTaps,
        sm: { mono: 0, st: 0, hr: 0, md: 0, vol: 0, ref: 0, refM: 0, refS: 0 }
      };

      bs.start(0, Math.random() * bs.buffer.duration);   // 随机起始相位，避免同步
      audio.voices.push(s._v);
    }

    updateReverb();
    applyMaster();
  }

  /* 注意：只设 coneInnerAngle，不要同时把 coneOuterAngle 设成 360，
     Chrome 内部会除零导致该 Panner 永久静音。 */
  function mkPanner(ctx, model) {
    const p = ctx.createPanner();
    p.panningModel = model;
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0.5;
    p.maxDistance = 40;
    p.coneInnerAngle = 360;
    return p;
  }

  function setPannerPos(pn, p) {
    if (pn.positionX) {
      pn.positionX.value = p.x;
      pn.positionY.value = p.y;
      pn.positionZ.value = p.z;
    } else {
      pn.setPosition(p.x, p.y, p.z);
    }
  }

  /* =========================================================
     FOA 双耳解码（虚拟扬声器法）
     8 个水平扬声器（45° 一档）+ 1 个顶置，每个扬声器的馈给是四个
     通道的线性组合：g_i = Σ_c B_c(d_i)·Y_c，其中 B 是与编码相同的
     实球谐基。把 9 路分别用 HRTF 定位后相加，就得到双耳信号。
     这就是「按播放设备解码」在耳机上的那一支。

     只在第一次切到 FOA 模式时构建——9 个 HRTF 卷积器不便宜，
     没用到就不该占 CPU。
     ========================================================= */
  function prepareFoa() {
    if (!audio.ctx || audio.foa.decoder) return audio.foa;
    const ctx = audio.ctx;

    const SPK = [];
    for (let i = 0; i < 8; i++) SPK.push({ az: i * 45, el: 0 });
    SPK.push({ az: 0, el: 90 });

    /* 归一化：9 路相干信号相加会明显大于单路。系数 1.50 是拿实测
       平均能量与 HRTF 模式对齐后定的（差 <1 dB），不是理论推导值 */
    const NORM = (2 / SPK.length) * 1.50;
    const R = 2;                          // 虚拟扬声器半径（米）

    SPK.forEach((sp) => {
      const az = sp.az * Math.PI / 180, el = sp.el * Math.PI / 180;
      const ce = Math.cos(el);
      const basis = [0.707, Math.cos(az) * ce, -Math.sin(az) * ce, Math.sin(el)];

      const sum = ctx.createGain();
      sum.gain.value = 1;
      basis.forEach((w, i) => {
        const g = ctx.createGain();
        g.gain.value = w * NORM;
        audio.foa.ch[i].connect(g);
        g.connect(sum);
      });

      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 1;
      pan.rolloffFactor = 0;              // 虚拟扬声器不参与距离衰减
      pan.maxDistance = 1000;
      pan.coneInnerAngle = 360;
      setPannerPos(pan, {
        x: Math.sin(az) * ce * R,
        y: NS.EAR_H + Math.sin(el) * R,
        z: -Math.cos(az) * ce * R
      });
      sum.connect(pan);
      pan.connect(audio.foa.tap);
    });

    audio.foa.decoder = { spk: SPK.length };
    return audio.foa;
  }


  /* 房间脉冲响应：纯扩散尾巴。
     早期反射已经由每条声源自己的镜像支路提供（带真实方向），
     这里再塞离散抽头等于重复计入一次，听感上就是"混响过厚"。
     前 18 ms 预延迟 + 45 ms 建立，避免开头突兀。 */
  function makeIR(seconds) {
    const ctx = audio.ctx;
    const sr = ctx.sampleRate;
    const len = Math.max(64, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const preDelay = Math.floor(sr * 0.018);
    const build = Math.max(1, Math.floor(sr * 0.045));

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i - preDelay;
        if (t <= 0) { d[i] = 0; continue; }
        const p = t / Math.max(1, len - preDelay);
        const env = Math.pow(1 - p, 2.4) * Math.min(1, t / build);
        const w = Math.random() * 2 - 1;
        lp = lp * 0.62 + w * 0.38;             // 压暗，避免刺耳
        d[i] = lp * env;
      }
    }
    return buf;
  }

  function updateReverb() {
    if (!audio.ctx) return;
    audio.conv.buffer = makeIR(state.rt60);
    audio.wet.gain.value = state.wet * 0.9;
    audio.dry.gain.value = 0.85 + (1 - state.wet) * 0.15;
  }

  function applyMaster() {
    if (!audio.ctx) return;
    audio.master.gain.value = state.master;
  }

  /* 每帧把声学参数写进音频图（平滑系数模拟 60fps 下的惯性） */
  function updateVoices() {
    for (const k in state.sources) {
      const s = state.sources[k], v = s._v;
      if (!v) continue;
      const c = s.cues, p = s.p;
      if (!c) continue;

      const wantVol = s.muted ? 0 : s.gain;
      v.sm.vol += (wantVol - v.sm.vol) * 0.18;
      v.vol.gain.value = v.sm.vol;

      setPannerPos(v.pSt, p);
      setPannerPos(v.pHr, p);

      /* ---- 空气吸收：低通 + 高架，随距离连续变化 ----
         用 setTargetAtTime 而不是直接赋 .value，拖声源时不会出现拉链噪声 */
      if (s.air) {
        const now = audio.ctx.currentTime;
        v.distLP.frequency.setTargetAtTime(s.air.cut, now, 0.05);
        v.distShelf.gain.setTargetAtTime(-s.air.shelfDb, now, 0.05);
      }

      /* ---- 一次反射：镜像位置 / 几何延迟 / 独立于直达的衰减 ---- */
      if (s.refl) {
        const r = s.refl;
        const now = audio.ctx.currentTime;

        setPannerPos(v.refPan, { x: r.mx, y: r.my, z: r.mz });
        v.refDelay.delayTime.setTargetAtTime(
          clamp(r.delay * state.refDelayScale, 0.0005, 0.155), now, 0.02);

        // 墙面吸声：越"软"的房间反射越暗（16 kHz → 3 kHz）
        v.refLP.frequency.setTargetAtTime(
          16000 - 13000 * clamp(state.refDamp, 0, 1), now, 0.05);

        // 反射衰减比直达慢 → 越远 D/R 越高，这是判断远近的关键线索
        const wantRef = s.muted ? 0
          : s.gain * (state.refLevel * NS.REF_COEF / (1 + NS.REF_DECAY * r.path));
        v.sm.ref += (wantRef - v.sm.ref) * 0.12;
        v.refGain.gain.value = v.sm.ref;

        // 单声道模式下反射不分方位（否则"单声道"就偷渡了方向信息）
        const mono = state.mode === 'mono';
        v.sm.refM += ((mono ? 1 : 0) - v.sm.refM) * 0.16;
        v.sm.refS += ((mono ? 0 : 1) - v.sm.refS) * 0.16;
        v.tapRefM.gain.value = v.sm.refM;
        v.tapRefS.gain.value = v.sm.refS;
      }

      const distG = 1 / (1 + 0.5 * Math.max(0, c.d - 1));   // 与 inverse 距离模型一致
      const m = state.mode;
      v.sm.mono += ((m === 'mono' ? distG : 0) - v.sm.mono) * 0.16;
      v.sm.st += ((m === 'stereo' ? 1 : 0) - v.sm.st) * 0.16;
      v.sm.hr += ((m === 'hrtf' ? 1 : 0) - v.sm.hr) * 0.16;
      v.sm.md += ((m === 'model' ? 1 : 0) - v.sm.md) * 0.16;
      v.tapMono.gain.value = v.sm.mono;
      v.tapSt.gain.value = v.sm.st;
      v.tapHr.gain.value = v.sm.hr;
      v.tapMd.gain.value = v.sm.md;

      v.gL.gain.value = c.gL * distG;
      v.gR.gain.value = c.gR * distG;
      v.dL.delayTime.value = Math.min(0.019, c.itdL);
      v.dR.delayTime.value = Math.min(0.019, c.itdR);
      v.fL.frequency.value = c.cutL;
      v.fR.frequency.value = c.cutR;

      /* ---- FOA 编码系数（AmbiX）：W 全向 / X 前 / Y 左 / Z 上 ----
         声源已被 vol 平滑过，所以这里不用再判断静音，不会产生咔嗒 */
      if (v.foa) {
        const a = c.azDeg * Math.PI / 180, e = c.elDeg * Math.PI / 180;
        const ce = Math.cos(e);
        /* 注意：FOA 支路取自 Panner 之前，拿不到 Panner 的距离衰减，
           所以这里要自己乘上——否则 FOA 模式里远近只剩高频差异，
           响度完全不随距离变化。 */
        const dg = distG;
        v.foa[0].gain.value = 0.707 * dg;
        v.foa[1].gain.value = Math.cos(a) * ce * dg;
        v.foa[2].gain.value = -Math.sin(a) * ce * dg;
        v.foa[3].gain.value = Math.sin(e) * dg;
      }
    }

    /* FOA 解码出口的总开关（场景级，只需设一次） */
    if (audio.foa && audio.foa.decoder) {
      const fm = state.mode === 'foa' ? 1 : 0;
      audio.foa.sm += (fm - audio.foa.sm) * 0.16;
      audio.foa.tap.gain.value = audio.foa.sm;
    }
  }

  Object.assign(NS, {
    audio, initAudio, mkPanner, setPannerPos, makeIR,
    updateReverb, applyMaster, updateVoices, prepareFoa,
    loadSamples, buildBarkLoop, resampleLinear
  });
})(window.SALab);
