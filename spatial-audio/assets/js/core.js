/* =========================================================
   core.js — 基础层
   · 通用工具函数
   · 物理/几何常量
   · 声源定义、场景预设、模式标签
   · 全局状态（唯一的数据源，其余模块共享同一对象引用）
   ========================================================= */
window.SALab = window.SALab || {};
(function (NS) {
  'use strict';

  /* ---------------- 通用工具 ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dbToGain = (db) => Math.pow(10, db / 20);

  /** '#aabbcc' + alpha → 'rgba(...)' */
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------------- 常量 ----------------
     坐标约定（与 Web Audio 一致）：
       地面 = XZ 平面，Y 轴向上，y = 0 就是地面；
       听者位于原点上方，耳平面高度 EAR_H；
       正前方 = -Z，右手边 = +X。
  ---------------------------------------- */
  const HEAD_R = 0.0875;   // 头部等效半径（m）
  const SOUND_C = 343;     // 声速（m/s，20℃ 空气）
  const EAR_H = 1.55;      // 听者耳平面离地高度（m）
  const ROOM_HALF = 4.6;   // 房间半边尺寸（m）
  const ROOM_H = 3.2;      // 房间净高（m）

  /* 一次反射的增益规律（engine 与读数共用，避免两处公式漂移）
     refGain = 声源音量 × refLevel × REF_COEF / (1 + REF_DECAY × 反射路径)
     路径按米计；REF_DECAY 远小于直达声的 1/r，所以越远反射相对越强。 */
  const REF_COEF = 0.30;
  const REF_DECAY = 0.04;

  /* ---------------- 声源定义 ---------------- */
  const DEFS = {
    dog:   { name: '狗叫', color: '#ffb457', sound: 'bark'  },
    steps: { name: '脚步', color: '#35e3c2', sound: 'steps' },
    bell:  { name: '铃声', color: '#a78bfa', sound: 'bell'  },
    rain:  { name: '雨声', color: '#5aa9ff', sound: 'rain'  },
    harp:  { name: '拨弦', color: '#ff7ac6', sound: 'harp'  },
    horn:  { name: '号角', color: '#ff6b6b', sound: 'horn'  }
  };

  /* ---------------- 场景预设 ----------------
     预设里没写到的声源一律静音，保证场景干净。
     y 为离地高度（米）。
     traj: { type:'static' }
         | { type:'line', ax,az,bx,bz, yA,yB, period }
         | { type:'orbit', radius, period }
         | { type:'path', pts:[{x,y,z}...], closed, period }
  -------------------------------------------- */
  const PRESETS = [
    {
      id: 'all', name: '全景默认', desc: '6 声源环绕', mode: 'hrtf', rt60: 0.9, wet: 35,
      src: {
        dog:   { x: -1.6, y: 0,   z: -1.4, gain: 0.85, traj: { type: 'line', ax: -2.3, az: 0.6, bx: -0.7, bz: -2.1, period: 7 } },
        steps: { x: 2.0,  y: 0,   z: 1.2,  gain: 0.7,  traj: { type: 'orbit', radius: 2.7, period: 18 } },
        bell:  { x: 1.8,  y: 1.5, z: -2.4, gain: 0.5,  traj: { type: 'static' } },
        rain:  { x: 0,    y: 1.9, z: 3.6,  gain: 0.46, traj: { type: 'static' } },
        harp:  { x: -2.8, y: 0.9, z: 2.0,  gain: 0.55, traj: { type: 'line', ax: -3.0, az: 2.6, bx: 2.6, bz: 2.2, period: 9 } },
        horn:  { x: 3.2,  y: 2.3, z: -1.0, gain: 0.45, traj: { type: 'static' } }
      }
    },
    {
      id: 'dog', name: '擦身而过', desc: '身后 → 左前', mode: 'hrtf', rt60: 0.8, wet: 45,
      src: {
        dog: { x: 0, y: 0, z: 2.0, gain: 0.95, traj: { type: 'line', ax: 0, az: 2.0, bx: -0.71, bz: -0.71, period: 6 } }
      }
    },
    {
      id: 'band', name: '乐队横移', desc: '前方扫向右侧', mode: 'hrtf', rt60: 1.0, wet: 40,
      src: {
        harp:  { x: -0.4, y: 1.0, z: -2.2, gain: 0.62, traj: { type: 'line', ax: -0.6, az: -2.2, bx: 2.6, bz: -0.4, period: 8 } },
        bell:  { x: 0,    y: 1.6, z: -2.8, gain: 0.46, traj: { type: 'line', ax: 0,    az: -2.8, bx: 2.8, bz: 0.6,  period: 8 } },
        horn:  { x: 0.6,  y: 2.2, z: -1.8, gain: 0.4,  traj: { type: 'line', ax: 0.6,  az: -1.8, bx: 2.2, bz: 1.4,  period: 8 } },
        steps: { x: 0,    y: 0,   z: -3.6, gain: 0.5,  traj: { type: 'static' } }
      }
    },
    {
      id: 'corridor', name: '走廊脚步', desc: '由远及近', mode: 'hrtf', rt60: 1.9, wet: 60,
      src: {
        steps: { x: 0, y: 0,   z: -4.0, gain: 0.9, traj: { type: 'line', ax: 0, az: -4.0, bx: 0, bz: -0.9, period: 9 } },
        bell:  { x: 0, y: 1.2, z: -3.4, gain: 0.3, traj: { type: 'static' } }
      }
    },
    {
      id: 'rain', name: '雨声环绕', desc: '缓慢环绕', mode: 'model', rt60: 1.4, wet: 55,
      src: {
        rain: { x: 0,    y: 1.8, z: 3.4,  gain: 0.6,  traj: { type: 'orbit', radius: 3.4, period: 26 } },
        bell: { x: -2.4, y: 0.8, z: -2.2, gain: 0.35, traj: { type: 'static' } }
      }
    },
    {
      id: 'path', name: '自由路径', desc: '手绘环线', mode: 'hrtf', rt60: 1.1, wet: 40,
      src: {
        steps: {
          x: -3.2, y: 0, z: -1.0, gain: 0.85,
          traj: {
            type: 'path', closed: true, period: 26,
            pts: [
              { x: -3.2, y: 0, z: -1.0 },
              { x: -1.0, y: 0, z: -2.8 },
              { x: 1.8,  y: 0, z: -1.6 },
              { x: 2.6,  y: 0, z: 1.4 },
              { x: -0.4, y: 0, z: 2.9 },
              { x: -2.9, y: 0, z: 1.3 }
            ]
          }
        }
      }
    }
  ];

  const MODE_LABEL = {
    mono: '单声道',
    stereo: '立体声',
    model: '双耳 · 模型',
    hrtf: '双耳 · HRTF',
    foa: '一阶 Ambisonics'
  };

  /* ---------------- 全局状态 ---------------- */
  const state = {
    mode: 'hrtf',        // mono | stereo | model | hrtf
    time: 0,             // 秒，驱动轨迹动画
    selected: 'dog',     // 当前选中的声源 key
    sources: {},         // key → 声源实例
    running: false,      // 音频是否在播放
    rt60: 0.9,
    wet: 0.35,
    master: 0.8,
    preset: 'all',

    /* 距离感知参数（界面上「距离与反射」面板可调） */
    absorb: 1,           // 空气吸收强度 0–2：高频随距离衰减的快慢
    refLevel: 0.8,       // 一次反射强度 0–1.5：决定直达/反射比
    refDelayScale: 1,    // 反射延迟倍率 0.4–2.5（几何延迟 × 该系数）
    refDamp: 0.5         // 墙面吸声 0–1：反射的高频损失
  };

  const SOURCE_KEYS = Object.keys(DEFS);

  SOURCE_KEYS.forEach((k) => {
    state.sources[k] = {
      key: k,
      def: DEFS[k],
      x: 0, y: 0, z: 0,
      gain: 0.6,
      muted: true,
      traj: { type: 'static' },
      p: { x: 0, y: 0, z: 0 },   // 当前帧位置
      cues: null,                // 当前帧双耳线索
      air: null,                 // 当前帧空气吸收（截止频率 / 高架衰减）
      refl: null,                // 当前帧一次反射（镜像位置 / 路径 / 延迟）
      _v: null                   // 音频节点（engine.js 建立后填入）
    };
  });

  Object.assign(NS, {
    $, $$, clamp, lerp, dbToGain, hexA,
    HEAD_R, SOUND_C, EAR_H, ROOM_HALF, ROOM_H, REF_COEF, REF_DECAY,
    DEFS, PRESETS, MODE_LABEL, SOURCE_KEYS, state
  });
})(window.SALab);
