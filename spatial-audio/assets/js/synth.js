/* =========================================================
   synth.js — 程序化声音合成
   每个函数返回 Float32Array（单声道 PCM），采样率取 AudioContext 的实际值。

   注意：犬吠（bark）与脚步（steps）在实际运行中优先使用 samples.js 里的
   真实录音，这里的实现是**录音解码失败时的回退**，两者都能出声。

   狗叫与脚步用「声源 — 滤波器」模型，而不是简单叠加谐波：
     · 狗叫：声门脉冲串（带抖动）→ 三条时变共振峰 → 送气噪声 → 唇辐射
     · 脚步：脚跟冲击 / 地板共振 / 鞋底摩擦三层叠加，左右脚交替
   ========================================================= */
(function (NS) {
  'use strict';

  /** 峰值归一化，避免削波 */
  function normalize(d, peak) {
    const target = peak || 0.9;
    let p = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
    if (p > 1e-6) { const g = target / p; for (let i = 0; i < d.length; i++) d[i] *= g; }
    return d;
  }

  /** 一阶低通 */
  function onePole(d, cut, sr) {
    const a = Math.exp(-2 * Math.PI * cut / sr);
    let y = 0;
    for (let i = 0; i < d.length; i++) { y = (1 - a) * d[i] + a * y; d[i] = y; }
    return d;
  }

  /** RBJ 双二阶滤波器（原地处理） */
  function biquad(d, sr, type, f0, Q, gainDb) {
    const w0 = 2 * Math.PI * Math.min(f0, sr * 0.48) / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(0.2, Q));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'hp') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bp') {          // 0 dB 峰值带通
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'peak') {
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    } else {                              // high shelf
      const b0n = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + b0n);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - b0n);
      a0 = (A + 1) - (A - 1) * cw + b0n;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - b0n;
    }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y;
    }
    return d;
  }

  /* ---------------------------------------------------------
     Klatt 二阶共振器（时变共振峰的核心）
     系数按「峰值增益 = 1」归一，这样各共振峰的强弱完全由外部增益决定，
     不会因为带宽不同而互相压制。
     --------------------------------------------------------- */
  function resonator(sr) {
    return {
      y1: 0, y2: 0, a: 1, b: 0, c: 0,
      set(sr, f, bw) {
        const r = Math.exp(-Math.PI * bw / sr);
        const th = 2 * Math.PI * f / sr;
        const ct = Math.cos(th), st = Math.sin(th);
        this.b = 2 * r * ct;
        this.c = -r * r;
        // |1 - b·e^{-jθ} - c·e^{-2jθ}| ，令 A 等于它，则峰值增益为 1
        const re = 1 - this.b * ct + this.c * Math.cos(2 * th);
        const im = this.b * st - this.c * Math.sin(2 * th);
        this.a = Math.max(1e-4, Math.hypot(re, im));
      },
      run(x) {
        const y = x * this.a + this.b * this.y1 + this.c * this.y2;
        this.y2 = this.y1; this.y1 = y;
        return y;
      }
    };
  }

  /* ---------------------------------------------------------
     分段平滑插值：给共振峰 / 包络写"关键帧"用
     curve(u, [[0,300],[0.4,880],[1,400]]) —— 段内用 smoothstep
     --------------------------------------------------------- */
  function curve(u, pts) {
    if (u <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i][0]) {
        const t = (u - pts[i - 1][0]) / ((pts[i][0] - pts[i - 1][0]) || 1);
        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (t * t * (3 - 2 * t));
      }
    }
    return pts[pts.length - 1][1];
  }

  const SYNTH = {
    /* =======================================================
       狗叫 —— 短促的「汪」
       一只中型犬连续吠叫，声音由三部分构成：
         1) 声门脉冲：基频 380–420 Hz 起音，40% 内快速滑落到 160–180 Hz
         2) 共振峰走一遍「w → ɑ → o」的口型：
            起口 F1≈300 / F2≈860（双唇收拢的 w），
            张口 F1≈880 / F2≈1520，收口 F1≈400 / F2≈880
         3) 送气噪声：起音 4 ms 内最重（爆破感），中段很轻（保持"汪"的音高清晰），
            末尾再抬一点（收口的气声）
       每次吠叫的基频、共振峰缩放、带宽、时长都做小幅随机，
       避免同一段波形重复出现听成电子音。
       ======================================================= */
    bark(sr) {
      const dur = 4.9, n = Math.floor(sr * dur), d = new Float32Array(n);

      /* 两组吠叫：第一组三声高一点，第二组三声低一点、慢一点 */
      const GROUPS = [[0.10, 0.40, 0.73], [2.86, 3.20, 3.55]];
      const events = [];
      GROUPS.forEach((g, gi) => {
        g.forEach((st) => {
          const base = gi === 0 ? 424 : 376;
          events.push({
            st,
            dur: 0.150 + Math.random() * 0.045,          // 150–195 ms
            f0: base * (1 + (Math.random() - 0.5) * 0.09),
            fall: 0.46 + Math.random() * 0.10,           // 收尾基频相对起音的比例
            fs: 1 + (Math.random() - 0.5) * 0.08,        // 共振峰整体缩放
            bw: 1 + (Math.random() - 0.5) * 0.26,        // 共振峰带宽缩放
            lvl: gi === 0 ? 1 : 0.9,                      // 第二组稍轻
            air: gi === 0 ? 1 : 1.25                      // 第二组气声更多
          });
        });
      });

      const f1 = resonator(sr), f2 = resonator(sr), f3 = resonator(sr), f4 = resonator(sr);

      events.forEach((ev) => {
        const i0 = Math.floor(ev.st * sr);
        const L = Math.floor(ev.dur * sr);
        const f0a = ev.f0, f0b = ev.f0 * ev.fall;

        let ph = 0, prevG = 0, prevOut = 0;
        let jit = 1, shim = 1, lpN = 0;

        for (let i = 0; i < L && i0 + i < n; i++) {
          const t = i / sr, u = i / L;

          /* --- 基频：起音后快速下滑，尾部缓降 --- */
          const glide = 1 - Math.exp(-u * 6.5);
          let f0 = f0a + (f0b - f0a) * glide;
          f0 *= 1 + 0.010 * Math.sin(2 * Math.PI * 47 * t);
          if ((i & 31) === 0) {
            jit = 1 + (Math.random() - 0.5) * 0.034;      // 周期抖动
            shim = 1 + (Math.random() - 0.5) * 0.07;      // 幅度抖动
          }
          f0 *= jit;

          /* --- 声门源：Rosenberg 脉冲的一阶差分 --- */
          ph += f0 / sr; if (ph >= 1) ph -= 1;
          const tp = 0.46, tn = 0.16;
          let g;
          if (ph < tp) g = 0.5 * (1 - Math.cos(Math.PI * ph / tp));
          else if (ph < tp + tn) g = Math.cos(Math.PI * 0.5 * (ph - tp) / tn);
          else g = 0;
          let src = (g - prevG) * 6.2;
          prevG = g;

          /* --- 送气噪声 --- */
          const nz = Math.random() * 2 - 1;
          const asp = (0.30 * Math.exp(-t * 55) + 0.095
                    + 0.28 * Math.pow(Math.max(0, u - 0.78) / 0.22, 2)) * ev.air;
          src += nz * asp;

          /* --- 时变共振峰 --- */
          if ((i & 31) === 0) {
            const F1 = curve(u, [[0, 300], [0.14, 780], [0.45, 880], [0.75, 640], [1, 400]]) * ev.fs;
            const F2 = curve(u, [[0, 860], [0.14, 1330], [0.45, 1520], [0.75, 1200], [1, 880]]) * ev.fs;
            const F3 = curve(u, [[0, 2350], [0.45, 2700], [1, 2450]]) * ev.fs;
            f1.set(sr, F1, 118 * ev.bw);
            f2.set(sr, F2, 175 * ev.bw);
            f3.set(sr, F3, 250);
            f4.set(sr, 3900 * ev.fs, 320);
          }

          let y = f1.run(src) + f2.run(src) * 0.55
                + f3.run(src) * 0.20 + f4.run(src) * 0.07;

          /* --- 唇辐射 --- */
          y = y - prevOut * 0.5;
          prevOut = y;

          /* --- 幅度包络：4 ms 起音 → 保持 → 快速收尾 --- */
          const env = Math.min(1, t / 0.004)
                    * curve(u, [[0, 1], [0.30, 1], [0.62, 0.66], [0.86, 0.26], [1, 0]]);

          /* --- 干燥的高频气声：给"汪"一点边缘，不吵 --- */
          lpN += (nz - lpN) * 0.075;
          const dry = (nz - lpN) * 0.22 * env;

          d[i0 + i] += (Math.tanh(y * 1.5) * 0.66 * env * shim + dry) * 0.42 * ev.lvl;
        }
      });

      biquad(d, sr, 'hp', 55, 0.7);
      biquad(d, sr, 'lp', 7600, 0.7);
      biquad(d, sr, 'peak', 950, 1.0, 1.5);
      return normalize(onePole(d, 10000, sr), 0.88);
    },

    /* =======================================================
       脚步 —— 清脆的「笃、笃」
       一层撞击三层音色，全部来自同一条 1 ms 上升的冲击噪声：
         低通 480 Hz  = 鞋体与地板的"闷底"（很轻）
         带通 700 Hz  = 主要的"笃"（木质共鸣）
         带通 2.3 kHz = 鞋跟落地的那一下"嗒"
       另有 150–205 Hz 的极短地板共振（30 ms 内衰完），
       以及 42 ms 后的前掌二次轻击。
       步频 0.52 s、抖动 ±3%，节奏稳定；音量按左右脚轻微交替。
       ======================================================= */
    steps(sr) {
      const dur = 7.0, n = Math.floor(sr * dur), d = new Float32Array(n);
      const CAD = 0.52;

      function addStep(t0, side, heavy) {
        const i0 = Math.floor(t0 * sr);
        const L = Math.floor(0.24 * sr);
        const pan = side ? 0.94 : 1.0;
        const sideF = side ? 1.05 : 0.97;          // 右脚鞋底更硬一点，共鸣更高
        const knockF = (150 + Math.random() * 55) * sideF;

        /* 极短的冲击噪声：0.9 ms 上升，80 ms 内衰减完 */
        const raw = new Float32Array(L);
        for (let i = 0; i < L; i++) {
          const t = i / sr;
          raw[i] = (Math.random() * 2 - 1) * Math.min(1, t / 0.0009) * Math.exp(-t * 85);
        }
        const body = Float32Array.from(raw);
        const mid = Float32Array.from(raw);
        const tap = Float32Array.from(raw);
        biquad(body, sr, 'lp', (430 + Math.random() * 110) * sideF, 0.7);
        biquad(mid, sr, 'bp', (640 + Math.random() * 170) * sideF, 1.0);
        biquad(tap, sr, 'bp', (1750 + Math.random() * 750) * sideF, 0.85);

        for (let i = 0; i < L && i0 + i < n; i++) {
          const t = i / sr;
          let v = body[i] * 0.72 + mid[i] * 3.2 + tap[i] * 0.85;

          /* 地板/鞋体的极短共振 */
          v += Math.sin(2 * Math.PI * knockF * t) * Math.exp(-t * 95) * 0.075;

          /* 鞋底与地面的细碎摩擦，只在头 30 ms */
          if (t > 0.004 && t < 0.034) {
            v += (Math.random() * 2 - 1) * Math.exp(-(t - 0.004) * 75) * 0.045;
          }

          /* 前掌落地：42 ms 后的第二次轻击 */
          if (t > 0.042 && t < 0.13) {
            const u = t - 0.042;
            v += (Math.sin(2 * Math.PI * knockF * 0.9 * u) * 0.10
                  + (Math.random() * 2 - 1) * Math.exp(-u * 90) * 0.09)
                 * Math.min(1, u / 0.002);
          }

          d[i0 + i] += v * 0.34 * heavy * pan;
        }
      }

      let t = 0.15, side = 0;
      while (t < dur - 0.35) {
        addStep(t, side, 0.90 + Math.random() * 0.18);
        t += CAD * (0.97 + Math.random() * 0.06);        // ±3% 步频起伏
        side ^= 1;
      }

      biquad(d, sr, 'hp', 60, 0.7);
      biquad(d, sr, 'peak', 1750, 1.0, 1.2);
      biquad(d, sr, 'lp', 9500, 0.7);
      return normalize(onePole(d, 12000, sr), 0.9);
    },

    /* 铃声：加性合成，五个非整数倍分音（金属感来源） */
    bell(sr) {
      const dur = 3.6, n = Math.floor(sr * dur), d = new Float32Array(n);
      const strikes = [0.05, 1.4, 2.62];
      const partials = [[1, 1, 2.4], [2.02, 0.48, 1.9], [2.98, 0.3, 1.5], [4.21, 0.17, 1.0], [5.43, 0.09, 0.7]];
      for (const st of strikes) {
        const i0 = Math.floor(st * sr), L = Math.floor(2.3 * sr), f0 = 880;
        for (let i = 0; i < L && i0 + i < n; i++) {
          const t = i / sr;
          let v = 0;
          for (const [r, a, dec] of partials) v += a * Math.sin(2 * Math.PI * f0 * r * t) * Math.exp(-t * dec);
          d[i0 + i] += v * Math.min(1, t / 0.003) * 0.24;
        }
      }
      return normalize(d);
    },

    /* 雨声：带通噪声床 + 随机水滴 */
    rain(sr) {
      const dur = 5, n = Math.floor(sr * dur), d = new Float32Array(n);
      let lp1 = 0, lp2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const w = Math.random() * 2 - 1;
        lp1 = lp1 * 0.62 + w * 0.38;
        lp2 = lp2 * 0.985 + lp1 * 0.015;
        const mod = 0.82 + 0.18 * Math.sin(2 * Math.PI * 0.12 * t) * Math.sin(2 * Math.PI * 0.31 * t + 1.2);
        d[i] = ((lp1 - lp2) * 1.5 + lp1 * 0.1) * mod * 0.5;
      }
      for (let k = 0; k < 220; k++) {
        const i0 = Math.floor(Math.random() * (n - 400)), L = 260;
        for (let i = 0; i < L; i++) d[i0 + i] += (Math.random() * 2 - 1) * Math.exp(-i / L * 7) * 0.12;
      }
      return normalize(d);
    },

    /* 拨弦：Karplus-Strong 弦模型，C 大调琶音 */
    harp(sr) {
      const dur = 4.8, d = new Float32Array(Math.floor(sr * dur));
      const notes = [261.63, 329.63, 392.0, 493.88, 523.25, 392.0, 329.63, 246.94,
                     293.66, 349.23, 440.0, 587.33, 493.88, 392.0];
      const step = 0.33;
      notes.forEach((f, k) => {
        const i0 = Math.floor(k * step * sr);
        const N = Math.max(2, Math.round(sr / f));
        const line = new Float32Array(N);
        for (let i = 0; i < N; i++) line[i] = (Math.random() * 2 - 1) * 0.9;
        let idx = 0, prev = 0;
        const L = Math.floor(1.9 * sr);
        for (let i = 0; i < L && i0 + i < d.length; i++) {
          const cur = line[idx];
          const nxt = (cur + prev) * 0.5 * 0.9968;
          line[idx] = nxt; prev = cur; idx = (idx + 1) % N;
          d[i0 + i] += cur * Math.exp(-i / sr * 0.85) * 0.45;
        }
      });
      return normalize(d);
    },

    /* 号角：奇次谐波堆成方波，双音叠加 */
    horn(sr) {
      const dur = 3.8, n = Math.floor(sr * dur), d = new Float32Array(n);
      const honks = [[0.06, 0.58], [1.02, 0.5], [2.3, 0.72]];
      const sq = (ph) => {
        let v = 0;
        for (let h = 1; h <= 9; h += 2) v += Math.sin(ph * h) / h;
        return v * 0.78;
      };
      for (const [st, len] of honks) {
        const i0 = Math.floor(st * sr), L = Math.floor(len * sr);
        for (let i = 0; i < L && i0 + i < n; i++) {
          const t = i / sr;
          let env = Math.min(1, t / 0.028) * Math.min(1, (len - t) / 0.09);
          env = Math.max(0, Math.min(1, env));
          const v = sq(2 * Math.PI * 415 * t) + 0.85 * sq(2 * Math.PI * 494 * t + 1.1)
                  + 0.25 * sq(2 * Math.PI * 830 * t);
          d[i0 + i] += v * env * 0.24;
        }
      }
      return normalize(onePole(d, 5200, sr));
    }
  };

  NS.normalize = normalize;
  NS.onePole = onePole;
  NS.biquad = biquad;
  NS.SYNTH = SYNTH;
})(window.SALab);
