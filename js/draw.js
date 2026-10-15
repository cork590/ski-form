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
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!visible) return;
    const i = Math.min(pose.frames.length - 1, Math.max(0, Math.round(video.currentTime * pose.fps)));
    const lm = pose.frames[i]?.lm;
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
  };
  loop();
  return () => cancelAnimationFrame(raf);
}

/** ターン1回分（0〜100%）の推移を お手本 / あなた で重ねて描く */
export function drawProfileChart(canvas, def, modelSeries, userSeries) {
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
}
