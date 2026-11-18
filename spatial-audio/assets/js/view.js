/* =========================================================
   view.js — 三维房间视图（Canvas 2D + 手写透视投影）

   为什么不用 WebGL / three.js：
     · 整个项目要求 file:// 双击可运行，不能引外部库
     · 这个场景只有几十个图元，2D 画布 + 手写投影足够，还能保留
       canvas 文字与混合模式的清晰度

   相机：绕场景中心的轨道相机（yaw / pitch / dist）
   交互：拖声源（地面平面求交）· Shift+拖改高度 · 拖空白转视角
         滚轮缩放 · 双击路径节点删除 · 「加点」模式在地面落点
   ========================================================= */
(function (NS) {
  'use strict';
  const { $, clamp, lerp, hexA, state, ROOM_HALF, ROOM_H, EAR_H } = NS;

  const cv = $('#room');
  const g = cv.getContext('2d');

  let VW = 0, VH = 0, DPR = 1;

  /* ---------------- 相机 ---------------- */
  const cam = {
    yaw: 0.58, pitch: 0.50, dist: 16.0,
    pivot: { x: 0, y: 1.15, z: 0 },
    fov: 48,
    spin: false
  };
  const eye = { x: 0, y: 0, z: 0 };
  const B = { fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };
  let focal = 800;

  function updateCamera() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    eye.x = cam.pivot.x + cam.dist * Math.sin(cam.yaw) * cp;
    eye.y = cam.pivot.y + cam.dist * sp;
    eye.z = cam.pivot.z + cam.dist * Math.cos(cam.yaw) * cp;

    let fx = cam.pivot.x - eye.x, fy = cam.pivot.y - eye.y, fz = cam.pivot.z - eye.z;
    const len = Math.hypot(fx, fy, fz) || 1;
    fx /= len; fy /= len; fz /= len;

    // right = forward × up(0,1,0)
    let rx = -fz, ry = 0, rz = fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    // up' = right × forward
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    B.fx = fx; B.fy = fy; B.fz = fz;
    B.rx = rx; B.ry = ry; B.rz = rz;
    B.ux = ux; B.uy = uy; B.uz = uz;

    focal = (VH * 0.5) / Math.tan(cam.fov * Math.PI / 360);
  }

  /** 世界坐标 → 屏幕坐标；返回 null 表示在相机后方 */
  function project(p) {
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    const zc = dx * B.fx + dy * B.fy + dz * B.fz;
    if (zc < 0.25) return null;
    const xc = dx * B.rx + dy * B.ry + dz * B.rz;
    const yc = dx * B.ux + dy * B.uy + dz * B.uz;
    return { x: VW / 2 + xc / zc * focal, y: VH / 2 - yc / zc * focal, z: zc, k: focal / zc };
  }

  /** 屏幕坐标 → 世界射线 */
  function rayDir(sx, sy) {
    const x = (sx - VW / 2) / focal;
    const y = -(sy - VH / 2) / focal;
    const dx = B.rx * x + B.ux * y + B.fx;
    const dy = B.ry * x + B.uy * y + B.fy;
    const dz = B.rz * x + B.uz * y + B.fz;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / l, y: dy / l, z: dz / l };
  }

  /** 射线与水平面 y = h 求交，用于把鼠标位置换算成地面坐标 */
  function pickPlane(sx, sy, h) {
    const d = rayDir(sx, sy);
    if (Math.abs(d.y) < 1e-4) return null;
    const t = (h - eye.y) / d.y;
    if (t <= 0) return null;
    return { x: eye.x + d.x * t, y: h, z: eye.z + d.z * t };
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    const r = cv.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    VW = Math.max(10, r.width);
    VH = Math.max(10, r.height);
    cv.width = Math.round(VW * DPR);
    cv.height = Math.round(VH * DPR);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!cam.userZoom) fitCamera();
  }

  /** 房间包围盒在屏幕上的尺寸 */
  function sceneFill() {
    const H = ROOM_HALF, TH = ROOM_H;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const sx of [-H, H]) {
      for (const sz of [-H, H]) {
        for (const sy of [0, TH]) {
          const q = project({ x: sx, y: sy, z: sz });
          if (!q) continue;
          x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
          y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
        }
      }
    }
    if (!isFinite(x0)) return 9;
    return Math.max((x1 - x0) / VW, (y1 - y0) / VH);
  }

  /** 让整个房间刚好装进画布，并把投影包围盒的竖向中心对到画布中心 */
  function fitCamera() {
    if (!VW || !VH) return;
    /* 竖屏（手机）画面窄而高，按 0.86 填宽会上下留一大截空白，
       所以竖屏用更满的比例。标签本身有边界收拢，不会溢出画布。 */
    const target = VH > VW * 1.05 ? 0.95 : 0.86;
    cam.pivot.x = 0; cam.pivot.z = 0; cam.pivot.y = 1.15;
    for (let pass = 0; pass < 3; pass++) {
      let lo = 5, hi = 34;
      for (let i = 0; i < 14; i++) {
        cam.dist = (lo + hi) / 2;
        updateCamera();
        if (sceneFill() > target) lo = cam.dist; else hi = cam.dist;
      }
      cam.dist = clamp(hi, 5, 34);
      updateCamera();

      /* 透视会让包围盒整体偏下，微调俯仰目标点把它摆正 */
      const b = sceneBox();
      if (!b) break;
      const offY = (b.y0 + b.y1) / 2 - VH / 2;
      const offX = (b.x0 + b.x1) / 2 - VW / 2;
      if (Math.abs(offY) < 4 && Math.abs(offX) < 4) break;
      // 屏幕像素 → 世界米：按包围盒所在深度换算
      const zp = Math.max(4, cam.dist);
      // 抬高视点会让场景在画面里下移，所以符号取反
      cam.pivot.y = clamp(cam.pivot.y - offY * zp / focal, -0.4, 2.4);
      const dx = offX * zp / focal;
      cam.pivot.x += dx * Math.cos(cam.yaw);
      cam.pivot.z -= dx * Math.sin(cam.yaw);
    }
  }

  function sceneBox() {
    const H = ROOM_HALF, TH = ROOM_H;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const sx of [-H, H]) {
      for (const sz of [-H, H]) {
        for (const sy of [0, TH]) {
          const q = project({ x: sx, y: sy, z: sz });
          if (!q) continue;
          x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
          y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
        }
      }
    }
    if (!isFinite(x0)) return null;
    return { x0, x1, y0, y1 };
  }

  /* ---------------- 绘制小工具 ---------------- */
  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function line3(a, b, style, width) {
    const p = project(a), q = project(b);
    if (!p || !q) return;
    g.strokeStyle = style;
    g.lineWidth = width || 1;
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }

  function poly3(pts, close) {
    g.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i]);
      if (!p) { started = false; continue; }
      if (!started) { g.moveTo(p.x, p.y); started = true; }
      else g.lineTo(p.x, p.y);
    }
    if (close && started) g.closePath();
  }

  /* ---------------- 地面与房间 ---------------- */
  function drawFloor() {
    const H = ROOM_HALF;
    const c = [[-H, 0, -H], [H, 0, -H], [H, 0, H], [-H, 0, H]];

    // 地面底色（径向渐变，中心在听者脚下）
    const o = project({ x: 0, y: 0, z: 0 });
    g.save();
    poly3(c, true);
    if (o) {
      const rad = Math.max(120, (focal / o.z) * 5.4);
      const grd = g.createRadialGradient(o.x, o.y, 10, o.x, o.y, rad);
      grd.addColorStop(0, 'rgba(40,62,82,0.95)');
      grd.addColorStop(0.55, 'rgba(23,36,49,0.95)');
      grd.addColorStop(1, 'rgba(13,20,29,0.95)');
      g.fillStyle = grd;
    } else {
      g.fillStyle = 'rgba(18,28,39,0.95)';
    }
    g.fill();
    g.strokeStyle = 'rgba(110,160,205,0.4)';
    g.lineWidth = 1.3;
    g.stroke();
    g.restore();

    // 1 米网格
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const major = Math.abs(i) === 4;
      const st = major ? 'rgba(120,165,205,0.26)' : 'rgba(110,155,200,0.15)';
      line3({ x: i, y: 0, z: -H }, { x: i, y: 0, z: H }, st, 1);
      line3({ x: -H, y: 0, z: i }, { x: H, y: 0, z: i }, st, 1);
    }
    // 中轴（正前 / 左右）
    line3({ x: 0, y: 0, z: -H }, { x: 0, y: 0, z: H }, 'rgba(90,169,255,0.30)', 1);
    line3({ x: -H, y: 0, z: 0 }, { x: H, y: 0, z: 0 }, 'rgba(90,169,255,0.20)', 1);
  }

  function drawWalls() {
    const H = ROOM_HALF, TH = ROOM_H;
    const walls = [
      [[-H, 0, -H], [H, 0, -H]],
      [[H, 0, -H], [H, 0, H]],
      [[H, 0, H], [-H, 0, H]],
      [[-H, 0, H], [-H, 0, -H]]
    ];
    g.save();
    for (const [a, b] of walls) {
      const A = { x: a[0], y: 0, z: a[2] }, Bp = { x: b[0], y: 0, z: b[2] };
      const tA = project({ x: A.x, y: TH, z: A.z });
      const tB = project({ x: Bp.x, y: TH, z: Bp.z });

      /* 墙面：自地面向上渐隐，读起来像"有体积的房间"而不挡住内部 */
      poly3([A, Bp, { x: Bp.x, y: TH, z: Bp.z }, { x: A.x, y: TH, z: A.z }], true);
      if (tA && tB) {
        const grd = g.createLinearGradient(0, Math.max(tA.y, tB.y), 0, Math.max(A.y, Bp.y));
        grd.addColorStop(0, 'rgba(90,140,190,0.012)');
        grd.addColorStop(1, 'rgba(90,150,200,0.075)');
        g.fillStyle = grd;
        g.fill();
      }
      g.strokeStyle = 'rgba(100,150,195,0.18)';
      g.lineWidth = 1;
      g.stroke();

      /* 墙面竖线（每米）与横线（每米） */
      const n = Math.round(Math.hypot(Bp.x - A.x, Bp.z - A.z));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        line3({ x: lerp(A.x, Bp.x, t), y: 0, z: lerp(A.z, Bp.z, t) },
              { x: lerp(A.x, Bp.x, t), y: TH, z: lerp(A.z, Bp.z, t) },
              'rgba(100,150,195,0.09)', 1);
      }
      for (let h = 1; h < TH; h++) {
        line3({ x: A.x, y: h, z: A.z }, { x: Bp.x, y: h, z: Bp.z }, 'rgba(100,150,195,0.07)', 1);
      }
    }
    g.restore();
  }

  /** 地面距离环（1–4 m） */
  function drawRings() {
    g.save();
    for (let m = 1; m <= 4; m++) {
      g.setLineDash([3, 6]);
      g.strokeStyle = m === 4 ? 'rgba(90,169,255,0.10)' : 'rgba(90,169,255,0.17)';
      g.lineWidth = 1;
      poly3(circlePts(m, 0), true);
      g.stroke();
      g.setLineDash([]);
      // 只标一个刻度，避免环上文字太多
      const lab = project({ x: 0, y: 0, z: -m });
      if (lab) {
        g.fillStyle = 'rgba(140,170,200,0.38)';
        g.font = '9px ui-monospace, monospace';
        g.textAlign = 'center';
        g.fillText(m + 'm', lab.x, lab.y - 4);
      }
    }
    g.restore();
  }

  function circlePts(r, y, n) {
    const N = n || 40, out = [];
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      out.push({ x: Math.sin(a) * r, y: y, z: -Math.cos(a) * r });
    }
    return out;
  }

  /** 方位提示：正前方 */
  function drawCompass() {
    const a = project({ x: 0, y: 0, z: -ROOM_HALF + 0.35 });
    const b = project({ x: 0, y: 0, z: -ROOM_HALF - 0.55 });
    if (a && b) {
      g.strokeStyle = 'rgba(140,170,200,0.35)';
      g.lineWidth = 1.4;
      g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(160,190,220,0.5)';
      g.font = '10px -apple-system,"PingFang SC",sans-serif';
      g.textAlign = 'center';
      g.fillText('前', b.x, b.y + 12);
    }
  }

  /* ---------------- 轨迹 ---------------- */
  function drawTrajectory(s) {
    const tr = s.traj;
    if (!tr || tr.type === 'static' || s.muted) return;
    const active = s === state.sources[state.selected];
    const col = s.def.color;

    g.save();
    g.strokeStyle = hexA(col, active ? 0.62 : 0.26);
    g.lineWidth = active ? 1.6 : 1.1;
    g.setLineDash([4, 5]);

    if (tr.type === 'line') {
      poly3([{ x: tr.ax, y: s.y, z: tr.az }, { x: tr.bx, y: s.y, z: tr.bz }], false);
      g.stroke();

    } else if (tr.type === 'orbit') {
      poly3(circlePts(tr.radius, s.y), true);
      g.stroke();

    } else if (tr.type === 'path') {
      const geo = NS.pathSamples(tr);
      if (geo.samples.length) {
        poly3(geo.samples.map((p) => ({ x: p.x, y: p.y, z: p.z })), !!tr.closed);
        g.stroke();
      }
    }
    g.restore();

    // 方向箭头：在轨迹中点画一个沿切向的小三角
    drawArrow(s);
  }

  function drawArrow(s) {
    const now = state.time;
    const cur = s.p;
    const ahead = NS.evalPos(s, now + 0.12);
    const a = project(cur), b = project(ahead);
    if (!a || !b) return;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (!isFinite(ang)) return;
    g.save();
    g.fillStyle = hexA(s.def.color, 0.7);
    g.beginPath();
    g.moveTo(b.x + Math.cos(ang) * 5, b.y + Math.sin(ang) * 5);
    g.lineTo(b.x + Math.cos(ang + 2.4) * 6, b.y + Math.sin(ang + 2.4) * 6);
    g.lineTo(b.x + Math.cos(ang - 2.4) * 6, b.y + Math.sin(ang - 2.4) * 6);
    g.closePath(); g.fill();
    g.restore();
  }

  /** 轨迹控制点（仅选中声源可见） */
  function drawHandles(s) {
    const tr = s.traj;
    if (!tr || s === null) return;
    const active = s === state.sources[state.selected];
    if (!active || s.muted) return;

    if (tr.type === 'line') {
      handle({ x: tr.ax, y: s.y, z: tr.az }, s.def.color, 'A');
      handle({ x: tr.bx, y: s.y, z: tr.bz }, s.def.color, 'B');
    } else if (tr.type === 'path' && tr.pts) {
      tr.pts.forEach((p, i) => handle(p, s.def.color, String(i + 1), true));
    }
  }

  function handle(p, color, label, isNode) {
    const q = project(p);
    if (!q) return;
    const r = 7;
    g.save();
    g.strokeStyle = hexA(color, 0.9);
    g.fillStyle = 'rgba(8,12,17,0.92)';
    g.lineWidth = 1.3;
    g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    if (isNode) {
      g.fillStyle = hexA(color, 0.95);
      g.font = '8.5px ui-monospace, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, q.x, q.y + 0.5);
    } else {
      g.fillStyle = hexA(color, 0.95);
      g.font = '9px ui-monospace, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, q.x, q.y + 0.5);
    }
    g.restore();
  }

  /* ---------------- 声源 ---------------- */
  function drawSource(s, isSel) {
    const head = project(s.p);
    if (!head) return;
    const base = project({ x: s.p.x, y: 0, z: s.p.z });
    const alive = !s.muted && state.running;
    const col = s.muted ? '#3a4756' : s.def.color;
    const k = head.k;                                  // 该深度下 1 米 = 多少像素
    const R = clamp(k * (isSel ? 0.095 : 0.082), 6, 16);

    g.save();

    /* 地面投影：椭圆 + 立柱，用来读出水平位置与高度 */
    if (base) {
      const rx = Math.max(3, k * 0.24), ry = Math.max(1.6, k * 0.24 * Math.sin(cam.pitch + 0.18));
      g.beginPath(); g.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = hexA(col, alive ? 0.2 : 0.08);
      g.fill();
      g.strokeStyle = hexA(col, 0.28);
      g.lineWidth = 1;
      g.stroke();
      if (s.p.y > 0.04) {
        const stem = g.createLinearGradient(base.x, base.y, head.x, head.y);
        stem.addColorStop(0, hexA(col, 0.42));
        stem.addColorStop(1, hexA(col, 0.12));
        g.strokeStyle = stem;
        g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(base.x, base.y); g.lineTo(head.x, head.y); g.stroke();
      }
    }

    /* 光晕 */
    const pulse = alive ? 1 + 0.07 * Math.sin(state.time * 3 + s.p.x) : 1;
    const rg = g.createRadialGradient(head.x, head.y, 0, head.x, head.y, R * 2.8 * pulse);
    rg.addColorStop(0, hexA(col, alive ? 0.55 : 0.2));
    rg.addColorStop(0.45, hexA(col, alive ? 0.14 : 0.05));
    rg.addColorStop(1, hexA(col, 0));
    g.fillStyle = rg;
    g.beginPath(); g.arc(head.x, head.y, R * 2.8 * pulse, 0, Math.PI * 2); g.fill();

    /* 选中环 */
    if (isSel) {
      g.strokeStyle = hexA(col, 0.6);
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath(); g.arc(head.x, head.y, R + Math.max(6, R * 0.8), 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }

    /* 主体 */
    g.beginPath(); g.arc(head.x, head.y, R, 0, Math.PI * 2);
    g.fillStyle = col;
    g.shadowColor = hexA(col, 0.9);
    g.shadowBlur = alive ? 14 : 3;
    g.fill();
    g.shadowBlur = 0;
    g.beginPath(); g.arc(head.x, head.y, R * 0.36, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fill();

    /* 标签统一延后绘制，避免相互压字（见 drawLabels） */
    queueLabel(head.x, head.y - R - 8,
      s.def.name + (s.p.y > 0.05 ? ' ' + s.p.y.toFixed(1) + 'm' : ''),
      s.muted, false);

    g.restore();
  }

  /* ---------------- 标签层的避让排布 ---------------- */
  let labelQueue = [];
  let listenerBox = null;

  function queueLabel(x, y, text, muted, below) {
    labelQueue.push({ x, y, text, muted, below });
  }

  function drawLabels() {
    if (!labelQueue.length) return;
    g.save();
    g.font = '11px -apple-system,"PingFang SC",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';

    // 听者本体也算障碍物，标签不许压在头上
    const placed = listenerBox ? [listenerBox] : [];
    // 从画面下方往上排，先占据靠近声源的位置
    labelQueue.slice().sort((a, b) => b.y - a.y).forEach((L) => {
      const w = g.measureText(L.text).width + 12;
      const h = 16;
      const x = clamp(L.x - w / 2, 4, VW - w - 4);
      let y = L.below ? L.y : L.y - h;
      y = clamp(y, 4, VH - h - 4);

      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((p) => x < p.x + p.w + 3 && x + w + 3 > p.x
                                    && y < p.y + p.h + 2 && y + h + 2 > p.y);
        if (!hit) break;
        y = L.below ? hit.y + hit.h + 3 : hit.y - h - 3;
        if (y < 4 || y + h > VH - 4) { y = hit.y - h - 3; break; }
      }

      placed.push({ x, y, w, h });

      /* 位移较大时用一根细线连回声源，避免"这标签是谁的" */
      const ax = L.x, ay = L.y;
      const bx = x + w / 2, by = L.below ? y : y + h;
      if (Math.abs(ax - bx) > 3 || Math.abs(ay - by) > 6) {
        g.strokeStyle = L.muted ? 'rgba(120,140,160,0.18)' : 'rgba(200,220,240,0.22)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      }

      g.fillStyle = 'rgba(8,12,17,0.82)';
      roundRect(x, y, w, h, 5);
      g.fill();
      g.fillStyle = L.muted ? 'rgba(140,160,180,0.45)' : 'rgba(232,240,248,0.92)';
      g.fillText(L.text, x + w / 2, y + 3);
    });
    g.restore();
  }

  /* ---------------- 听者 ---------------- */
  function drawListener() {
    const head = project({ x: 0, y: EAR_H, z: 0 });
    if (!head) return;
    const k = head.k;
    const R = clamp(k * 0.135, 6, 22);

    g.save();

    /* 脚下光圈 */
    poly3(circlePts(0.45, 0.01), true);
    g.fillStyle = 'rgba(53,227,194,0.05)';
    g.fill();
    g.strokeStyle = 'rgba(53,227,194,0.22)';
    g.lineWidth = 1;
    g.stroke();

    /* 身体：肩部做成一个可见的"半身"色块，跟声源的圆点区分开 */
    const shoulder = project({ x: 0, y: EAR_H - 0.42, z: 0 });
    let shH = 0, shW = 0;
    if (shoulder) {
      const sw = shW = Math.max(9, k * 0.21), sh = shH = Math.max(6, k * 0.13);
      g.beginPath();
      g.ellipse(shoulder.x, shoulder.y, sw, sh, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(9,17,24,0.96)';
      g.fill();
      g.strokeStyle = 'rgba(53,227,194,0.42)';
      g.lineWidth = 1.3;
      g.stroke();
      // 脖子
      g.beginPath();
      g.moveTo(head.x - sw * 0.22, shoulder.y - sh * 0.4);
      g.lineTo(head.x - sw * 0.26, head.y + R * 0.85);
      g.lineTo(head.x + sw * 0.26, head.y + R * 0.85);
      g.lineTo(head.x + sw * 0.22, shoulder.y - sh * 0.4);
      g.closePath();
      g.fillStyle = 'rgba(9,17,24,0.96)';
      g.fill();
      g.strokeStyle = 'rgba(53,227,194,0.3)';
      g.stroke();
    }

    /* 头 */
    const rg = g.createRadialGradient(head.x - R * 0.3, head.y - R * 0.35, R * 0.15, head.x, head.y, R);
    rg.addColorStop(0, 'rgba(46,74,88,0.98)');
    rg.addColorStop(1, 'rgba(10,18,26,0.98)');
    g.beginPath(); g.arc(head.x, head.y, R, 0, Math.PI * 2);
    g.fillStyle = rg;
    g.fill();
    g.strokeStyle = 'rgba(53,227,194,0.85)';
    g.lineWidth = 1.6;
    g.stroke();

    /* 双耳 */
    const earL = project({ x: -0.075, y: EAR_H, z: 0 });
    const earR = project({ x: 0.075, y: EAR_H, z: 0 });
    if (earL && earR) {
      g.fillStyle = 'rgba(53,227,194,0.9)';
      g.beginPath(); g.ellipse(earL.x, earL.y, Math.max(2, R * 0.3), Math.max(3, R * 0.45), 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(earR.x, earR.y, Math.max(2, R * 0.3), Math.max(3, R * 0.45), 0, 0, Math.PI * 2); g.fill();
    }

    /* 朝向：指向正前方（-Z） */
    const fTip = project({ x: 0, y: EAR_H, z: -0.62 });
    if (fTip) {
      const ang = Math.atan2(fTip.y - head.y, fTip.x - head.x);
      g.strokeStyle = 'rgba(53,227,194,0.5)';
      g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(head.x, head.y); g.lineTo(fTip.x, fTip.y); g.stroke();
      g.fillStyle = 'rgba(53,227,194,0.6)';
      g.beginPath();
      g.moveTo(fTip.x, fTip.y);
      g.lineTo(fTip.x - Math.cos(ang - 0.5) * 7, fTip.y - Math.sin(ang - 0.5) * 7);
      g.lineTo(fTip.x - Math.cos(ang + 0.5) * 7, fTip.y - Math.sin(ang + 0.5) * 7);
      g.closePath(); g.fill();
    }

    /* 标签放在肩部以下，别压住身体；同时把本体登记为障碍物 */
    const labelY = (shoulder ? shoulder.y + shH : head.y + R) + 8;
    queueLabel(head.x, labelY, '听者', false, true);

    const top = head.y - R - 2;
    listenerBox = {
      x: head.x - Math.max(shW, R) - 4,
      y: top,
      w: Math.max(shW, R) * 2 + 8,
      h: labelY - top
    };

    g.restore();
  }

  /* ---------------- 主绘制 ---------------- */
  function draw() {
    if (cam.spin) cam.yaw += 0.0022;
    updateCamera();

    g.clearRect(0, 0, VW, VH);

    // 背景
    const bg = g.createLinearGradient(0, 0, 0, VH);
    bg.addColorStop(0, '#101a26');
    bg.addColorStop(0.55, '#0a1017');
    bg.addColorStop(1, '#070b10');
    g.fillStyle = bg;
    g.fillRect(0, 0, VW, VH);

    drawFloor();
    drawWalls();
    drawRings();
    drawCompass();

    // 轨迹（都在地面附近，先画）
    for (const k in state.sources) drawTrajectory(state.sources[k]);
    for (const k in state.sources) drawHandles(state.sources[k]);

    // 声源与听者按深度排序，远的先画（静音的声源不进入场景）
    labelQueue = [];
    listenerBox = null;
    const items = [];
    for (const k in state.sources) {
      const s = state.sources[k];
      if (s.muted) continue;
      const q = project(s.p);
      if (q) items.push({ z: q.z, fn: () => drawSource(s, s === state.sources[state.selected]) });
    }
    const lq = project({ x: 0, y: EAR_H, z: 0 });
    if (lq) items.push({ z: lq.z, fn: drawListener });
    items.sort((a, b) => b.z - a.z);
    items.forEach((it) => it.fn());

    // 标签最后画，统一避让
    drawLabels();
  }

  /* =========================================================
     交互
     ========================================================= */
  let drag = null;
  const edit = { mode: null };          // 'add' = 点击落点

  function localXY(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitTest(sx, sy) {
    const sel = state.sources[state.selected];

    /* 1) 选中声源的控制点优先 */
    if (sel && !sel.muted) {
      const tr = sel.traj;
      if (tr.type === 'line') {
        const a = project({ x: tr.ax, y: sel.y, z: tr.az });
        const b = project({ x: tr.bx, y: sel.y, z: tr.bz });
        if (a && Math.hypot(sx - a.x, sy - a.y) < 12) return { kind: 'A', s: sel };
        if (b && Math.hypot(sx - b.x, sy - b.y) < 12) return { kind: 'B', s: sel };
      } else if (tr.type === 'path' && tr.pts) {
        for (let i = 0; i < tr.pts.length; i++) {
          const q = project(tr.pts[i]);
          if (q && Math.hypot(sx - q.x, sy - q.y) < 12) return { kind: 'node', s: sel, idx: i };
        }
      }
    }

    /* 2) 声源本体 */
    let best = null, bestD = 22;
    for (const k in state.sources) {
      const s = state.sources[k];
      if (s.muted) continue;
      const q = project(s.p);
      if (!q) continue;
      const d = Math.hypot(sx - q.x, sy - q.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? { kind: 'src', s: best } : null;
  }

  function onDown(e) {
    if (e.button === 1) return;
    const { x, y } = localXY(e);

    /* 加点模式：直接在声源当前高度的平面上落点 */
    if (edit.mode === 'add') {
      const s = state.sources[state.selected];
      if (s) {
        const p = pickPlane(x, y, s.y);
        if (p) {
          if (s.traj.type !== 'path') {
            s.traj = { type: 'path', closed: false, period: 20, pts: [] };
          }
          s.traj.pts.push({
            x: clamp(p.x, -ROOM_HALF, ROOM_HALF),
            y: s.y,
            z: clamp(p.z, -ROOM_HALF, ROOM_HALF)
          });
          NS.syncSelection();
        }
      }
      return;
    }

    const hit = hitTest(x, y);

    if (hit && hit.kind === 'src') {
      if (hit.s.key !== state.selected) {
        state.selected = hit.s.key;
        NS.syncSelection();
      }
      const s = hit.s;
      const q = project(s.p);
      drag = {
        kind: 'src', s,
        axis: e.shiftKey ? 'y' : 'xz',
        planeY: s.y,
        start: { x, y },
        startY: e.clientY,
        origY: s.y,
        pxPerM: q ? q.k : 40,
        // 记录拖动开始时的完整几何，拖动过程按增量平移，避免累积误差
        orig: {
          x: s.p.x, z: s.p.z,
          ax: s.traj.ax, az: s.traj.az, bx: s.traj.bx, bz: s.traj.bz,
          pts: s.traj.pts ? s.traj.pts.map((p) => ({ x: p.x, y: p.y, z: p.z })) : null
        }
      };
    } else if (hit) {
      const s = hit.s;
      const node = hit.kind === 'node' ? s.traj.pts[hit.idx] : null;
      const qn = project(node || s.p);
      drag = {
        kind: hit.kind, s,
        idx: hit.idx,
        axis: e.shiftKey ? 'y' : 'xz',
        planeY: node ? node.y : s.y,
        start: { x, y },
        startY: e.clientY,
        origY: node ? node.y : s.y,
        pxPerM: qn ? qn.k : 40
      };
    } else {
      // 空白处：转视角
      drag = { kind: 'cam', start: { x, y }, yaw: cam.yaw, pitch: cam.pitch };
      cam.spin = false;
      if (NS.syncCamUi) NS.syncCamUi();
    }

    cv.classList.add('dragging');
    cv.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!drag) return;
    const { x, y } = localXY(e);

    if (drag.kind === 'cam') {
      cam.yaw = drag.yaw - (x - drag.start.x) * 0.0065;
      cam.pitch = clamp(drag.pitch + (y - drag.start.y) * 0.005, 0.06, 1.45);
      return;
    }

    /* 竖向拖动：Shift 改高度 */
    if (drag.axis === 'y') {
      const dy = (drag.startY - e.clientY) / Math.max(20, drag.pxPerM);
      const ny = clamp(drag.origY + dy, 0, ROOM_H - 0.15);
      const s = drag.s;
      if (drag.kind === 'node') {
        s.traj.pts[drag.idx].y = ny;
      } else if (drag.kind === 'A' || drag.kind === 'B') {
        s.y = ny;
      } else {
        const delta = ny - s.y;
        s.y = ny;
        if (s.traj.type === 'path' && s.traj.pts) s.traj.pts.forEach((q) => { q.y += delta; });
      }
      NS.syncSelection();
      return;
    }

    const p = pickPlane(x, y, drag.planeY);
    if (!p) return;
    const s = drag.s;
    const nx = clamp(p.x, -ROOM_HALF, ROOM_HALF);
    const nz = clamp(p.z, -ROOM_HALF, ROOM_HALF);

    if (drag.kind === 'node') {
      s.traj.pts[drag.idx].x = nx;
      s.traj.pts[drag.idx].z = nz;
    } else if (drag.kind === 'A' || drag.kind === 'B') {
      const key = drag.kind === 'A' ? 'a' : 'b';
      s.traj[key + 'x'] = nx;
      s.traj[key + 'z'] = nz;
    } else {
      // 拖声源本体：按起点增量整体平移，形状不变
      const dx = p.x - drag.orig.x;
      const dz = p.z - drag.orig.z;
      if (s.traj.type === 'static') {
        s.x = nx; s.z = nz;
      } else if (s.traj.type === 'line') {
        s.traj.ax = clamp(drag.orig.ax + dx, -ROOM_HALF, ROOM_HALF);
        s.traj.az = clamp(drag.orig.az + dz, -ROOM_HALF, ROOM_HALF);
        s.traj.bx = clamp(drag.orig.bx + dx, -ROOM_HALF, ROOM_HALF);
        s.traj.bz = clamp(drag.orig.bz + dz, -ROOM_HALF, ROOM_HALF);
      } else if (s.traj.type === 'orbit') {
        s.traj.radius = clamp(Math.hypot(p.x, p.z), 0.8, ROOM_HALF - 0.3);
      } else if (s.traj.type === 'path' && drag.orig.pts) {
        s.traj.pts.forEach((q, i) => {
          q.x = clamp(drag.orig.pts[i].x + dx, -ROOM_HALF, ROOM_HALF);
          q.z = clamp(drag.orig.pts[i].z + dz, -ROOM_HALF, ROOM_HALF);
        });
      }
    }
    NS.syncSelection();
  }

  function onUp() {
    drag = null;
    cv.classList.remove('dragging');
  }

  function onDblClick(e) {
    const { x, y } = localXY(e);
    const sel = state.sources[state.selected];
    if (!sel || sel.traj.type !== 'path' || !sel.traj.pts) return;
    for (let i = 0; i < sel.traj.pts.length; i++) {
      const q = project(sel.traj.pts[i]);
      if (q && Math.hypot(x - q.x, y - q.y) < 12) {
        sel.traj.pts.splice(i, 1);
        NS.syncSelection();
        return;
      }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0011), 4.5, 34);
    cam.userZoom = true;
  }

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('dblclick', onDblClick);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 双击会误触发 pointerdown 的加点，这里挡掉：加点模式用单击即可 */

  /* ---------------- 视角预设 ---------------- */
  const VIEWS = {
    oblique: { yaw: 0.58, pitch: 0.50 },
    top:     { yaw: 0.0,  pitch: 1.40 },
    side:    { yaw: Math.PI / 2, pitch: 0.22 }
  };

  function setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    cam.yaw = v.yaw; cam.pitch = v.pitch;
    cam.spin = false;
    cam.userZoom = false;
    fitCamera();
  }

  function setEditMode(m) { edit.mode = m; }

  Object.assign(NS, { resize, draw, camera: cam, setView, setEditMode, project, pickPlane });
})(window.SALab);
