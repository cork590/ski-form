// 動画への骨格オーバーレイと、ターン中の推移グラフ
import { PHASES } from './analysis.js';

const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const LEFT = new Set([11, 13, 15, 23, 25, 27, 29, 31]);

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * 枠の中に動画が縦横比を保って表示されている範囲（object-fit: contain と同じ計算）。
 * 画面の高さで動画が縮んでも、骨格や枠が動画とずれないようにする。
 */
export function containRect(w, h, vw, vh) {
  const s = Math.min(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

/** 動画の再生位置に合わせて骨格を描き続ける。戻り値を呼ぶと停止。 */
// 1コマ分の骨格（と切り出し範囲・状態の表示）を描く。w, h は動画が表示されている範囲の大きさ
function drawOverlay(ctx, w, h, f) {
  if (f?.roi) {
    // 自動ズームで切り出した範囲
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(f.roi[0] * w, f.roi[1] * h, f.roi[2] * w, f.roi[3] * h);
    ctx.restore();
  }
  if (f && f.status && f.status !== 'ok' && f.status !== 'gap') {
    const msg = { small: '人物が小さすぎるため解析していません', skip: '解析範囲外' }[f.status] ?? '人物が見つかりません';
    ctx.font = '600 13px system-ui, sans-serif';
    const tw = ctx.measureText(msg).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, 8, tw + 16, 26);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, 16, 21);
  }
  const lm = f?.lm;
  if (!lm) return;
  const left = cssVar('--bone-left'), right = cssVar('--bone-right');
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (lm[a][2] < 0.3 || lm[b][2] < 0.3) continue;
    ctx.strokeStyle = LEFT.has(a) && LEFT.has(b) ? left : (!LEFT.has(a) && !LEFT.has(b) ? right : '#ffffff');
    ctx.beginPath();
    ctx.moveTo(lm[a][0] * w, lm[a][1] * h);
    ctx.lineTo(lm[b][0] * w, lm[b][1] * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (let k = 11; k < lm.length; k++) {
    if (lm[k][2] < 0.3) continue;
    ctx.beginPath();
    ctx.arc(lm[k][0] * w, lm[k][1] * h, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 動画の再生位置に合わせて骨格を描き続ける。戻り値を呼ぶと停止。 */
export function attachSkeleton(video, canvas, pose, isVisible) {
  let raf = 0;
  let last = -1;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const visible = isVisible();
    const key = visible ? video.currentTime : -2;
    if (key === last && canvas.width) return;
    last = key;
    const { ctx, w: cw, h: ch } = fitCanvas(canvas);
    ctx.clearRect(0, 0, cw, ch);
    if (!visible) return;
    const r = containRect(cw, ch, pose.width, pose.height);
    ctx.save();
    ctx.translate(r.x, r.y);
    const i = Math.min(pose.frames.length - 1, Math.max(0, Math.round(video.currentTime * pose.fps)));
    drawOverlay(ctx, r.w, r.h, pose.frames[i]);
    ctx.restore();
  };
  loop();
  return () => cancelAnimationFrame(raf);
}

/**
 * 解析したコマの画像をパラパラ漫画のように再生する（動画プレーヤーを使わない）。
 * 切り取った範囲のコマだけを持っているので、範囲外が映ることはなく、画像と骨格が必ず一致する。
 * iPhone の動画プレーヤーはシーク後の画像が更新されないことがあるため、こちらを使う。
 */
export function createFlipbook(canvas, pose, { isSkeletonVisible, onChange = () => {} }) {
  const [a, b] = pose.range ?? [0, pose.duration];
  const first = Math.max(0, Math.round(a * pose.fps));
  const last = Math.min(pose.frames.length - 1, Math.round(b * pose.fps));
  const images = new Map();
  const imageAt = (i) => {
    // 取りこぼしたコマ（画像なし）は、手前で一番近い画像を使う
    for (let k = i; k >= first; k--) {
      const src = pose.frames[k]?.img;
      if (!src) continue;
      if (!images.has(k)) {
        const img = new Image();
        img.onload = () => { if (Math.round(pos) === i || !state.playing) dirty = true; };
        img.src = src;
        images.set(k, img);
      }
      return images.get(k);
    }
    return null;
  };
  let pos = first;
  let rate = 1;
  let lastTs = 0;
  let dirty = true;
  let raf = 0;
  const state = { playing: false };
  let lastKey = '';

  const draw = () => {
    const i = Math.round(pos);
    const visible = isSkeletonVisible();
    const key = [i, visible, canvas.clientWidth, canvas.clientHeight].join('|');
    if (!dirty && key === lastKey) return;
    dirty = false;
    lastKey = key;
    const { ctx, w: cw, h: ch } = fitCanvas(canvas);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const r = containRect(cw, ch, pose.width, pose.height);
    const img = imageAt(i);
    if (img?.complete && img.naturalWidth) ctx.drawImage(img, r.x, r.y, r.w, r.h);
    if (visible) {
      ctx.save();
      ctx.translate(r.x, r.y);
      drawOverlay(ctx, r.w, r.h, pose.frames[i]);
      ctx.restore();
    }
  };
  const loop = (ts) => {
    raf = requestAnimationFrame(loop);
    if (state.playing && lastTs) {
      pos += ((ts - lastTs) / 1000) * pose.fps * rate;
      if (pos >= last) {
        pos = last;
        state.playing = false;
      }
      onChange();
    }
    lastTs = ts;
    draw();
  };
  raf = requestAnimationFrame(loop);
  // 先に画像を読み込んでおく（再生中のちらつきを防ぐ）
  for (let i = first; i <= last; i++) imageAt(i);

  return {
    hasImages: pose.frames.slice(first, last + 1).some((f) => f.img),
    get length() { return (last - first) / pose.fps; },
    get time() { return (pos - first) / pose.fps; },
    get playing() { return state.playing; },
    play(r = 1) {
      rate = r;
      if (pos >= last) pos = first;
      state.playing = true;
      onChange();
    },
    pause() { state.playing = false; onChange(); },
    /** 範囲の始めからの秒数で移動 */
    seek(t) { pos = Math.min(last, Math.max(first, first + t * pose.fps)); dirty = true; onChange(); },
    /** 元の動画のコマ番号で移動 */
    seekFrame(i) { pos = Math.min(last, Math.max(first, i)); dirty = true; onChange(); },
    redraw() { dirty = true; },
    destroy() { cancelAnimationFrame(raf); },
  };
}

/** ターン1回分（0〜100%）の推移を お手本 / あなた で重ねて描く */
export function drawProfileChart(canvas, def, modelSeries, userSeries, live = null) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  const all = [...modelSeries, ...userSeries];
  let lo = Math.min(...all), hi = Math.max(...all);
  const minSpan = def.thr * 3;
  if (hi - lo < minSpan) {
    const c = (hi + lo) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  const margin = (hi - lo) * 0.1;
  lo -= margin; hi += margin;
  const x = (i, n) => pad.l + (i / (n - 1)) * pw;
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

  // 局面の帯
  PHASES.forEach((p, i) => {
    if (i % 2 === 1) {
      ctx.fillStyle = cssVar('--chart-band');
      ctx.fillRect(pad.l + p.a * pw, pad.t, (p.b - p.a) * pw, ph);
    }
  });

  // 軸ラベル
  ctx.fillStyle = cssVar('--text-muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [lo + margin, hi - margin]) {
    ctx.fillText(v.toFixed(def.digits), pad.l - 6, y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('切り替え', pad.l, h - pad.b + 6);
  ctx.fillText('50%', pad.l + pw / 2, h - pad.b + 6);
  ctx.fillText('切り替え', pad.l + pw - 14, h - pad.b + 6);

  const line = (series, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    series.forEach((v, i) => (i ? ctx.lineTo(x(i, series.length), y(v)) : ctx.moveTo(x(i, series.length), y(v))));
    ctx.stroke();
  };
  line(modelSeries, cssVar('--series-model'), 2);
  line(userSeries, cssVar('--series-user'), 2.5);

  // 連動表示：今の局面の縦線と、今のコマの値（グラフの範囲外は端に寄せる）
  if (live) {
    const cx = pad.l + live.phase * pw;
    ctx.strokeStyle = cssVar('--text');
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, pad.t);
    ctx.lineTo(cx, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    const dot = (v, color) => {
      if (v == null || !isFinite(v)) return;
      const cy = Math.min(pad.t + ph, Math.max(pad.t, y(v)));
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = cssVar('--surface');
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    dot(live.model, cssVar('--series-model'));
    dot(live.user, cssVar('--series-user'));
  }
}
