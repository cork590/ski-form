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
  if (f && f.status && f.status !== 'ok' && f.status !== 'gap' && !f.predicted) {
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
  // 前後のコマから予測した骨格は、点線・半透明で区別する
  if (f.predicted) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([5, 4]);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(8, 8, 116, 24);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('予測（前後のコマから）', 14, 20);
  }
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
  if (f.predicted) ctx.restore();
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

// 局面の名前（谷回り・フォールライン・山回り・切り返し）
export function turnPhaseName(phase, fallFrac) {
  if (phase < 0.06 || phase > 0.94) return '切り返し';
  if (Math.abs(phase - fallFrac) < 0.04) return 'フォールライン';
  return phase < fallFrac ? '谷回り' : '山回り';
}

/**
 * 谷回り・山回りのタイミングを、お手本とあなたで並べて描く。
 * rows: [{ label, color, fallFrac, valleySec, mountainSec }]、phase: 今の局面（0〜1）
 */
export function drawTimingChart(canvas, rows, phase) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 58, padR = 10, top = 6, rowH = 30, gap = 10;
  const bw = w - padL - padR;
  const x = (f) => padL + f * bw;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  rows.forEach((r, k) => {
    const y = top + k * (rowH + gap);
    ctx.fillStyle = r.color;
    ctx.textAlign = 'left';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(r.label, 0, y + rowH / 2);
    ctx.font = '12px system-ui, sans-serif';
    // 谷回り（濃い）・山回り（薄い）
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x(0), y, x(r.fallFrac) - x(0), rowH);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x(r.fallFrac), y, x(1) - x(r.fallFrac), rowH);
    ctx.globalAlpha = 1;
    // フォールライン
    ctx.strokeStyle = cssVar('--surface');
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x(r.fallFrac), y - 3);
    ctx.lineTo(x(r.fallFrac), y + rowH + 3);
    ctx.stroke();
    // 文字（入りきるときだけ）
    const label = (text, a, b, color) => {
      if (ctx.measureText(text).width + 8 > x(b) - x(a)) return;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(text, (x(a) + x(b)) / 2, y + rowH / 2);
    };
    label(`谷回り ${r.valleySec.toFixed(2)}秒`, 0, r.fallFrac, '#ffffff');
    label(`山回り ${r.mountainSec.toFixed(2)}秒`, r.fallFrac, 1, cssVar('--text'));
  });
  // 目盛り：両端が切り返し、白い線がフォールライン
  const yb = top + rows.length * (rowH + gap) - gap + 14;
  ctx.fillStyle = cssVar('--text-muted');
  ctx.textAlign = 'left';
  ctx.fillText('切り返し', x(0), yb);
  ctx.textAlign = 'right';
  ctx.fillText('切り返し', x(1), yb);
  ctx.textAlign = 'center';
  ctx.fillText('白い線＝フォールライン', x(0.5), yb);
  // 今の局面
  if (phase != null) {
    ctx.strokeStyle = cssVar('--text');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(phase), 0);
    ctx.lineTo(x(phase), top + rows.length * (rowH + gap) - gap + 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * 谷回り・山回り・切り返しを、8の字（右の輪＝右ターン、左の輪＝左ターン、交点＝切り返し）
 * または円（1ターン＝1周、一番上＝切り返し）で描く。輪1周の時間を均等に割り当てるので、
 * フォールライン（●）の位置のずれが、そのままタイミングの差になる。
 * rows: [{ label, color, bySign: {1: {fallFrac}, -1: {fallFrac}}, now: { sign, phase } | null }]
 */
export function drawTurnShape(canvas, rows, shape) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  // 外側から順に（お手本→あなた）少しずつ小さく描く
  const scales = rows.map((_, k) => 1 - k * 0.24);

  // 8の字（ジェルノのレムニスケート）：θ=0,π が交点。右の輪 θ∈[0,π]、左の輪 θ∈[π,2π]
  const R8 = Math.min(w * 0.46, h * 0.95);
  const fig8 = (theta, s) => [cx + Math.sin(theta) * R8 * s, cy - Math.sin(theta) * Math.cos(theta) * R8 * s];
  // 円：一番上が切り返し、時計回り
  const RC = Math.min(w, h) * 0.42;
  const circle = (theta, s) => [cx + Math.sin(theta) * RC * s, cy - Math.cos(theta) * RC * s];

  const pointAt = (sign, phase, s) => (shape === 'circle'
    ? circle(phase * Math.PI * 2, s)
    : fig8((sign > 0 ? 0 : Math.PI) + phase * Math.PI, s));

  const arc = (sign, from, to, s, color, alpha, width) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const n = 48;
    for (let k = 0; k <= n; k++) {
      const [x, y] = pointAt(sign, from + ((to - from) * k) / n, s);
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  const dot = ([x, y], r, fill, stroke) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  };

  rows.forEach((r, k) => {
    const s = scales[k];
    // 円は今のターンの向き（なければ右ターン）だけを描く
    const signs = shape === 'circle' ? [r.now?.sign || 1] : [1, -1];
    for (const sign of signs) {
      const f = r.bySign[sign].fallFrac;
      arc(sign, 0, f, s, r.color, 0.95, 6);   // 谷回り
      arc(sign, f, 1, s, r.color, 0.3, 6);    // 山回り
      dot(pointAt(sign, f, s), 5, cssVar('--surface'), r.color); // フォールライン
    }
  });

  // 切り返し（8の字の交点／円の一番上）
  const top = shape === 'circle' ? circle(0, 1) : [cx, cy];
  ctx.fillStyle = cssVar('--text');
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('切り返し', top[0], top[1] - 8);
  ctx.textBaseline = 'middle';
  if (shape === 'circle') {
    ctx.fillStyle = cssVar('--text-muted');
    ctx.fillText('↻ 時計回り', cx, cy);
  } else {
    ctx.fillStyle = cssVar('--text-muted');
    ctx.textAlign = 'left';
    ctx.fillText('左ターン', 4, 10);
    ctx.textAlign = 'right';
    ctx.fillText('右ターン', w - 4, 10);
  }

  // 今の位置
  rows.forEach((r, k) => {
    if (!r.now || !r.now.sign) return;
    dot(pointAt(r.now.sign, r.now.phase, scales[k]), 7, r.color, '#ffffff');
  });
}
