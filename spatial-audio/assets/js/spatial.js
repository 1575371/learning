/* =========================================================
   spatial.js — 空间属性计算层
   · evalPos      轨迹求值：由时间算出当前声源位置
   · binauralOf   双耳线索模型：ITD / ILD / 两耳增益 / 头部遮蔽
   · computeScene 每帧刷新所有声源的位置与线索
   所有几何量都以「听者双耳」为原点计算，y 为离地高度。
   ========================================================= */
(function (NS) {
  'use strict';
  const { clamp, lerp, dbToGain, HEAD_R, SOUND_C, EAR_H, ROOM_HALF,
          REF_COEF, REF_DECAY, state } = NS;

  /* =========================================================
     自由路径：把控制点变成一条平滑、可匀速行走的曲线
     · Catmull-Rom 样条穿过所有控制点（点就是轨迹本身，不会被"拉偏"）
     · 按累积弧长取样，保证沿路径速度均匀
     ========================================================= */
  const SUB = 20;                       // 每段细分点数

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  /** 生成（并缓存）路径的密集取样点与累积弧长 */
  function pathSamples(tr) {
    const pts = tr.pts || [];
    const key = tr.closed + '|' + pts.map((p) => p.x.toFixed(3) + ',' + p.y.toFixed(3) + ',' + p.z.toFixed(3)).join(';');
    if (tr._key === key && tr._geo) return tr._geo;

    const n = pts.length;
    const samples = [];
    if (n >= 2) {
      const segs = tr.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p0 = pts[(i - 1 + n) % n];
        const p3 = pts[(i + 2) % n];
        // 开放路径的两端缺少邻点，用端点自身顶替，避免甩出去
        const a = (!tr.closed && i === 0) ? p1 : p0;
        const b = (!tr.closed && i === segs - 1) ? p2 : p3;
        for (let k = 0; k < SUB; k++) {
          const t = k / SUB;
          samples.push({
            x: catmull(a.x, p1.x, p2.x, b.x, t),
            y: catmull(a.y, p1.y, p2.y, b.y, t),
            z: catmull(a.z, p1.z, p2.z, b.z, t)
          });
        }
      }
      samples.push(tr.closed ? { x: pts[0].x, y: pts[0].y, z: pts[0].z }
                             : { x: pts[n - 1].x, y: pts[n - 1].y, z: pts[n - 1].z });
    }

    const cum = [0];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }

    tr._key = key;
    tr._geo = { samples, cum, total: cum[cum.length - 1] || 0 };
    return tr._geo;
  }

  function sampleAt(geo, dist) {
    const { samples, cum, total } = geo;
    if (!samples.length) return null;
    if (samples.length === 1 || total <= 1e-6) return samples[0];
    const d = clamp(dist, 0, total);
    // 二分找到所在区间
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / span;
    const a = samples[lo], b = samples[hi];
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
  }

  /* ---------------------------------------------------------
     轨迹求值
     static : 固定位置
     line   : A→B 往返，smoothstep 缓入缓出
     orbit  : 绕听者匀速环绕
     path   : 用户自绘路径，闭合则循环，开放则来回走
     --------------------------------------------------------- */
  function evalPos(s, t) {
    const tr = s.traj;
    if (!tr || tr.type === 'static') return { x: s.x, y: s.y, z: s.z };

    if (tr.type === 'line') {
      const ph = ((t || 0) / (tr.period || 6)) % 1;
      const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;      // 0→1→0 三角波
      const e = tri * tri * (3 - 2 * tri);             // smoothstep
      return { x: lerp(tr.ax, tr.bx, e), y: s.y, z: lerp(tr.az, tr.bz, e) };
    }

    if (tr.type === 'path') {
      const geo = pathSamples(tr);
      if (!geo.samples.length) return { x: s.x, y: s.y, z: s.z };
      let u = ((t || 0) / (tr.period || 20)) % 1;
      if (!tr.closed) u = u < 0.5 ? u * 2 : 2 - u * 2;  // 开放路径来回走
      const p = sampleAt(geo, u * geo.total);
      return p || { x: s.x, y: s.y, z: s.z };
    }

    // orbit
    const ph = ((t || 0) / (tr.period || 16)) % 1;
    const ang = ph * Math.PI * 2;
    const r = tr.radius || 2;
    return { x: Math.sin(ang) * r, y: s.y, z: -Math.cos(ang) * r };
  }

  /* ---------------------------------------------------------
     双耳线索模型
     输入：声源的世界坐标（y = 离地高度）
     输出：方位角、仰角、距离、ITD、ILD、两耳增益、两耳低通截止频率

     ITD —— Woodworth 球头近似：
        τ = (a / c) · (θ + sin θ)，a 为头部等效半径，θ 为侧向角
        侧向 90° 时约 0.66 ms，与实测数据量级一致
     ILD —— 头部遮蔽引起的声级差，侧向最大约 9 dB，
        按 ±ildDb/2 分配给两耳，保证总响度大致不变
     远耳高频遮蔽 —— 截止频率随侧向角指数下降（低频绕射、高频被挡）
     空气吸收 —— 距离越远高频衰减越多
     --------------------------------------------------------- */
  function binauralOf(pos) {
    // 换到以双耳为原点的坐标
    const px = pos.x, py = pos.y - EAR_H, pz = pos.z;

    const d = Math.max(0.15, Math.hypot(px, py, pz));
    const azDeg = Math.atan2(px, -pz) * 180 / Math.PI;    // 0 = 正前，+ = 右
    const elDeg = Math.asin(clamp(py / d, -1, 1)) * 180 / Math.PI;

    const az = azDeg * Math.PI / 180;
    const elAbs = Math.abs(elDeg) * Math.PI / 180;
    /* Woodworth 公式里的 θ 是「侧向角」（相对正中面，最大 90°），
       不是方位角。直接拿方位角代入的话，正后方的声源会得到 180°，
       ITD 反而超过物理上限——所以这里先投影到侧向。 */
    const th = Math.abs(Math.asin(clamp(px / Math.max(1e-6, Math.hypot(px, pz)), -1, 1)));
    const elScale = Math.cos(elAbs * 0.8);                       // 高低角会削弱侧向线索

    const itdMs = (HEAD_R / SOUND_C) * (th + Math.sin(th)) * 1000 * elScale;
    // ILD 必须带符号：右正左负，否则左右耳会被镜像
    const ildDb = 9 * Math.sin(az) * elScale;

    const gR = dbToGain(ildDb / 2);
    const gL = dbToGain(-ildDb / 2);

    const rightLeads = az > 0.0001;
    const itdL = rightLeads ? itdMs / 1000 : 0;                  // 秒，供 DelayNode 使用
    const itdR = rightLeads ? 0 : itdMs / 1000;

    const shadow = Math.exp(-2.5 * Math.sin(th) * elScale);
    /* 只保留头部遮蔽；空气吸收改由独立的距离滤波级负责（四种模式共用），
       否则「模型」模式会被扣两次高频。 */
    const farCut = clamp(18000 * shadow, 1100, 18000);
    const cutL = ildDb > 0 ? farCut : 18000;
    const cutR = ildDb < 0 ? farCut : 18000;

    return { d, azDeg, elDeg, itdMs, ildDb, gL, gR, itdL, itdR, cutL, cutR, rightLeads };
  }

  /* =========================================================
     距离感知 1：空气吸收
     真实空气对高频的衰减随距离近似指数增长，所以远处的声源会先失去
     "空气感"和齿音，而不是整体变小声。这里用两级：
       · 低通   —— 越远截止越低（Q 0.4，斜缓，不会像低通滤波那样发闷）
       · 高架   —— 3.2 kHz 以上整体下压若干 dB（宽带的高频倾斜）
     absorb = 0 时两级都旁路（= 只有音量随距离变），用来对照。
     ========================================================= */
  function airOf(p) {
    const d = Math.hypot(p.x, p.y - EAR_H, p.z);
    const a = clamp(state.absorb, 0, 2.5);
    const dd = Math.max(0, d - 0.8);            // 1 m 内不衰减
    return {
      cut: clamp(20000 * Math.exp(-0.17 * dd * a), 1500, 20000),
      shelfDb: clamp(1.8 * dd * a, 0, 14)
    };
  }

  /* =========================================================
     距离感知 2：一次反射（镜像声源法）

     把声源对**最近的墙**做镜像，得到虚声源 S'；
     反射路径 = |S' - 听者|，比直达多走的那段就是延迟：
         Δt = (|S' - L| - |S - L|) / c
     虚声源的方向就是反射声的入射方向——所以反射不是简单加混响，
     而是真的从另一侧来的声音。

     增益：反射的衰减比直达慢（直达按 1/r，反射更接近房间的稳态声场），
     于是「直达/反射比」随距离下降，这正是人耳判断远近的主要依据之一。
     ========================================================= */
  const REF_L = { x: 0, y: EAR_H, z: 0 };

  function reflectionOf(p) {
    const W = ROOM_HALF;
    const dx = W - Math.abs(p.x);          // 到左右墙的距离
    const dz = W - Math.abs(p.z);          // 到前后墙的距离
    let mx = p.x, my = p.y, mz = p.z;
    if (dx <= dz) mx = (p.x >= 0 ? 2 * W - p.x : -2 * W - p.x);
    else mz = (p.z >= 0 ? 2 * W - p.z : -2 * W - p.z);

    const direct = Math.hypot(p.x - REF_L.x, p.y - REF_L.y, p.z - REF_L.z);
    const path = Math.hypot(mx - REF_L.x, my - REF_L.y, mz - REF_L.z);
    const extra = path - direct;
    return {
      mx, my, mz,
      path,
      direct,
      extra,
      /* 下限 3.5 ms：贴着墙的声源几何延迟可能不到 1 ms，那样会与直达声
         形成等间距很密的梳状滤波器，听起来空洞发金属声。真实房间有这种
         边界干涉，但对这个演示来说不值得——宁可按小房间处理。 */
      delay: clamp(extra / SOUND_C, 0.0035, 0.14)
    };
  }

  /** 直达/反射比（dB），用于界面读数；不含声源自身音量 */
  function drOf(s) {
    const distG = 1 / (1 + 0.5 * Math.max(0, s.cues.d - 1));
    const refG = state.refLevel * REF_COEF / (1 + REF_DECAY * s.refl.path);
    return 20 * Math.log10(Math.max(1e-4, refG / distG));
  }

  /** 每帧刷新：位置 → 线索 */
  function computeScene() {
    for (const k in state.sources) {
      const s = state.sources[k];
      s.p = evalPos(s, state.time);
      s.cues = binauralOf(s.p);
      s.air = airOf(s.p);
      s.refl = reflectionOf(s.p);
    }
  }

  Object.assign(NS, {
    evalPos, binauralOf, computeScene, pathSamples, airOf, reflectionOf, drOf
  });
})(window.SALab);
