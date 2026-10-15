// お手本とあなたの3D骨格を同じ向き・同じ視点にそろえ、ターンの局面を合わせて人形で再生する
import { LM, PHASES } from './analysis.js';
import { fitCanvas, cssVar } from './draw.js';

const RAD = Math.PI / 180;

// [始点, 終点, 太さ（脚の長さ比）]
const LIMBS = [
  [LM.lHip, LM.lKnee, 0.17], [LM.lKnee, LM.lAnk, 0.13],
  [LM.rHip, LM.rKnee, 0.17], [LM.rKnee, LM.rAnk, 0.13],
  [LM.lSh, LM.lEl, 0.1], [LM.lEl, LM.lWr, 0.08],
  [LM.rSh, LM.rEl, 0.1], [LM.rEl, LM.rWr, 0.08],
  [LM.lHeel, LM.lFoot, 0.08], [LM.rHeel, LM.rFoot, 0.08],
];
const LEFT_SIDE = new Set([LM.lHip, LM.lKnee, LM.lSh, LM.lEl, LM.lHeel]);

export const VIEWS = {
  front: { yaw: 0, pitch: 8 },
  diag: { yaw: 40, pitch: 12 },
  side: { yaw: 90, pitch: 5 },
  back: { yaw: 180, pitch: 8 },
  top: { yaw: 0, pitch: 70 },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const rotY = (p, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
};

// MediaPipe 座標（y下向き・z奥向き）→ 描画座標（y上向き・z手前向き）にして、
// 体の正面の平均方向を手前に向け、脚の長さ = 1 に正規化、足元を原点に置く
function prepare(ana) {
  let sx = 0, sz = 0;
  for (const m of ana.raw) {
    sx += Math.sin(m.hipYaw * RAD);
    sz += -Math.cos(m.hipYaw * RAD);
  }
  const align = -Math.atan2(sx, sz);
  const legs = ana.raw.map((m) => m.legLen).sort((a, b) => a - b);
  const scale = 1 / (legs[Math.floor(legs.length / 2)] || 1);
  return ana.wl.map((w) => {
    const pts = w.map((p) => rotY([p[0] * scale, -p[1] * scale, -p[2] * scale], align));
    const ank = mid(pts[LM.lAnk], pts[LM.rAnk]);
    const floor = Math.min(pts[LM.lAnk][1], pts[LM.rAnk][1]);
    return pts.map((p) => [p[0] - ank[0], p[1] - floor, p[2] - ank[2]]);
  });
}

function poseAt(poses, fi) {
  const a = Math.max(0, Math.min(poses.length - 1, Math.floor(fi)));
  const b = Math.min(poses.length - 1, a + 1);
  const t = fi - a;
  return poses[a].map((p, k) => p.map((v, d) => v + (poses[b][k][d] - v) * t));
}

// あなたの各フレームに、同じ向き・同じ局面のお手本フレームを対応させる
function buildTimeline(model, user) {
  const entries = [];
  if (model.fallback || user.fallback) {
    const N = user.wl.length, M = model.wl.length;
    for (let i = 0; i < N; i++) {
      const p = i / Math.max(1, N - 1);
      entries.push({ ui: i, mi: p * (M - 1), turn: -1, phase: p, sign: 0 });
    }
    return entries;
  }
  const bySign = { 1: model.turns.filter((t) => t.sign > 0), [-1]: model.turns.filter((t) => t.sign < 0) };
  const count = { 1: 0, [-1]: 0 };
  user.turns.forEach((t, k) => {
    const pool = bySign[t.sign].length ? bySign[t.sign] : model.turns;
    const mt = pool[count[t.sign]++ % pool.length];
    const n = t.end - t.start;
    for (let i = t.start; i < t.end; i++) {
      const p = (i - t.start) / n;
      entries.push({ ui: i, mi: mt.start + p * (mt.end - mt.start), turn: k, phase: p, sign: t.sign });
    }
  });
  return entries;
}

function shade(hex, t) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (v) => Math.round(v * (1 - t));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function project(p, view, panel) {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
  const x = p[0] * cy + p[2] * sy;
  const z = -p[0] * sy + p[2] * cy;
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const y = p[1] * cp - z * sp;
  return { x: panel.ox + x * panel.k, y: panel.oy - y * panel.k, d: p[1] * sp + z * cp };
}

function drawGround(ctx, view, panel) {
  ctx.strokeStyle = cssVar('--viewer-grid');
  ctx.lineWidth = 1;
  for (let v = -1.5; v <= 1.501; v += 0.5) {
    for (const [a, b] of [[[v, 0, -1.5], [v, 0, 1.5]], [[-1.5, 0, v], [1.5, 0, v]]]) {
      const pa = project(a, view, panel), pb = project(b, view, panel);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }
}

function drawFigure(ctx, pose, view, panel, color, alpha) {
  const P = pose.map((p) => project(p, view, panel));
  const items = [];

  // 板（かかと→つま先の方向に伸ばす）
  for (const [ank, heel, toe] of [[LM.lAnk, LM.lHeel, LM.lFoot], [LM.rAnk, LM.rHeel, LM.rFoot]]) {
    let d = sub(pose[toe], pose[heel]);
    d = [d[0], 0, d[2]];
    const l = Math.hypot(d[0], d[2]);
    d = l > 1e-3 ? [d[0] / l, 0, d[2] / l] : [0, 0, 1];
    const a = pose[ank];
    const tip = project([a[0] + d[0] * 1.05, Math.max(0, a[1] - 0.06), a[2] + d[2] * 1.05], view, panel);
    const tail = project([a[0] - d[0] * 0.75, Math.max(0, a[1] - 0.06), a[2] - d[2] * 0.75], view, panel);
    items.push({ kind: 'line', a: tail, b: tip, w: 0.05, d: (tip.d + tail.d) / 2 - 0.01, c: shade(color, 0.55) });
  }

  for (const [a, b, w] of LIMBS) {
    items.push({ kind: 'line', a: P[a], b: P[b], w, d: (P[a].d + P[b].d) / 2, c: shade(color, LEFT_SIDE.has(a) ? 0.18 : 0) });
  }
  const torso = [P[LM.lSh], P[LM.rSh], P[LM.rHip], P[LM.lHip]];
  items.push({ kind: 'poly', pts: torso, d: torso.reduce((s, p) => s + p.d, 0) / 4, c: shade(color, 0.08) });
  const head = project(mid(pose[LM.lEar], pose[LM.rEar]), view, panel);
  const neck = project(mid(pose[LM.lSh], pose[LM.rSh]), view, panel);
  items.push({ kind: 'line', a: neck, b: head, w: 0.08, d: (neck.d + head.d) / 2 - 0.02, c: shade(color, 0.1) });
  items.push({ kind: 'head', p: head, r: 0.12, d: head.d, c: shade(color, 0.04) });

  items.sort((a, b) => a.d - b.d);
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const outline = cssVar('--viewer-outline');
  for (const it of items) {
    if (it.kind === 'line') {
      for (const [c, extra] of [[outline, 2], [it.c, 0]]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = it.w * panel.k + extra;
        ctx.beginPath();
        ctx.moveTo(it.a.x, it.a.y);
        ctx.lineTo(it.b.x, it.b.y);
        ctx.stroke();
      }
    } else if (it.kind === 'poly') {
      ctx.beginPath();
      it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = it.c;
      ctx.strokeStyle = it.c;
      ctx.lineWidth = 0.12 * panel.k;
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(it.p.x, it.p.y, it.r * panel.k, 0, Math.PI * 2);
      ctx.fillStyle = it.c;
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function phaseName(p) {
  return (PHASES.find((ph) => p >= ph.a && p < ph.b) ?? PHASES[PHASES.length - 1]).name;
}

export function createViewer({ canvas, model, user, info, seek, playBtn, speedSel, onSeek }) {
  const modelPoses = prepare(model);
  const userPoses = prepare(user);
  const timeline = buildTimeline(model, user);
  const view = { yaw: 0, pitch: 8 * RAD };
  let mode = 'side';
  let pos = 0;
  let playing = false;
  let lastTs = 0;
  let raf = 0;

  const setPlaying = (v) => {
    playing = v;
    playBtn.textContent = v ? '❚❚ 一時停止' : '▶ 再生';
    if (!v) onSeek(timeline[Math.round(pos)]);
  };

  function draw() {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.fillStyle = cssVar('--viewer-bg');
    ctx.fillRect(0, 0, w, h);
    // コマの間を補間（ターンの境目でお手本側が飛ぶときは補間しない）
    const i0 = Math.min(timeline.length - 1, Math.floor(pos));
    const e = timeline[i0], e1 = timeline[Math.min(timeline.length - 1, i0 + 1)];
    const t = pos - i0;
    const lerp = (a, b) => (Math.abs(b - a) > 2 ? a : a + (b - a) * t);
    const mPose = poseAt(modelPoses, lerp(e.mi, e1.mi));
    const uPose = poseAt(userPoses, lerp(e.ui, e1.ui));
    const k = Math.min(h / 2.9, (mode === 'side' ? w / 2 : w) / 3.2);
    const cModel = cssVar('--series-model'), cUser = cssVar('--series-user');

    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    if (mode === 'side') {
      const panels = [{ ox: w * 0.25, oy: h * 0.8, k }, { ox: w * 0.75, oy: h * 0.8, k }];
      panels.forEach((p) => drawGround(ctx, view, p));
      drawFigure(ctx, mPose, view, panels[0], cModel, 1);
      drawFigure(ctx, uPose, view, panels[1], cUser, 1);
      ctx.fillStyle = cModel;
      ctx.fillText('お手本', 12, 10);
      ctx.fillStyle = cUser;
      ctx.fillText('あなた', w / 2 + 12, 10);
      ctx.strokeStyle = cssVar('--viewer-grid');
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
    } else {
      const panel = { ox: w / 2, oy: h * 0.8, k };
      drawGround(ctx, view, panel);
      drawFigure(ctx, mPose, view, panel, cModel, 0.5);
      drawFigure(ctx, uPose, view, panel, cUser, 0.85);
      ctx.fillStyle = cModel;
      ctx.fillText('お手本（薄い色）', 12, 10);
      ctx.fillStyle = cUser;
      ctx.fillText('あなた', 12, 28);
    }

    info.textContent = e.turn >= 0
      ? `ターン ${e.turn + 1} / ${user.turns.length}（${e.sign > 0 ? '右' : '左'}ターン）・ ${phaseName(e.phase)}`
      : `動画全体の ${Math.round(e.phase * 100)}%`;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (playing && lastTs) {
      pos += ((ts - lastTs) / 1000) * user.fps * Number(speedSel.value);
      if (pos >= timeline.length - 1) pos = 0;
      seek.value = String(Math.round((pos / Math.max(1, timeline.length - 1)) * 1000));
    }
    lastTs = ts;
    draw();
  }

  const onPlay = () => setPlaying(!playing);
  const onInput = () => {
    pos = (Number(seek.value) / 1000) * (timeline.length - 1);
    if (playing) setPlaying(false);
    else onSeek(timeline[Math.round(pos)]);
  };
  let drag = null;
  const onDown = (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!drag) return;
    view.yaw = drag.yaw - (e.clientX - drag.x) * 0.01;
    view.pitch = Math.max(-10 * RAD, Math.min(85 * RAD, drag.pitch + (e.clientY - drag.y) * 0.01));
  };
  const onUp = () => { drag = null; };

  playBtn.addEventListener('click', onPlay);
  seek.addEventListener('input', onInput);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  seek.value = '0';
  setPlaying(false);
  raf = requestAnimationFrame(frame);

  return {
    setView(name) {
      view.yaw = VIEWS[name].yaw * RAD;
      view.pitch = VIEWS[name].pitch * RAD;
    },
    setMode(m) { mode = m; },
    destroy() {
      cancelAnimationFrame(raf);
      playBtn.removeEventListener('click', onPlay);
      seek.removeEventListener('input', onInput);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    },
  };
}
