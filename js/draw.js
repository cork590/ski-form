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
export function createFlipbook(canvas, pose, { isSkeletonVisible, isZoom = () => false, onChange = () => {}, video = null }) {
  const [a, b] = pose.range ?? [0, pose.duration];
  const first = Math.max(0, Math.round(a * pose.fps));
  const last = Math.min(pose.frames.length - 1, Math.round(b * pose.fps));
  const images = new Map();
  const zoomImages = new Map();
  const zoomAt = (i) => {
    const src = pose.frames[i]?.zoom;
    if (!src) return null;
    if (!zoomImages.has(i)) {
      const img = new Image();
      img.onload = () => { dirty = true; };
      img.src = src;
      zoomImages.set(i, img);
    }
    return zoomImages.get(i);
  };
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
  // 再生中は元の動画をなめらかに描き、骨格とズーム範囲はコマの間を補間する（usingVideo）。
  // 止まっている間は解析したコマの画像を表示する（iPhone でシーク後の画像が更新されない問題を避けるため）
  let usingVideo = false;
  const lerpArr = (a, b, t) => a.map((v, k) => (Array.isArray(v) ? lerpArr(v, b[k], t) : v + (b[k] - v) * t));
  const at = (key, p) => {
    const i0 = Math.floor(p), i1 = Math.min(last, i0 + 1), t = p - i0;
    const a = pose.frames[i0]?.[key], b = pose.frames[i1]?.[key];
    if (a && b) return lerpArr(a, b, t);
    return a ?? b ?? null;
  };
  let pos = first;
  let rate = 1;
  let lastTs = 0;
  let dirty = true;
  let raf = 0;
  const state = { playing: false };
  const stopVideo = () => {
    if (usingVideo && video && !video.paused) video.pause();
    usingVideo = false;
  };
  let lastKey = '';

  const draw = () => {
    const i = Math.round(pos);
    const visible = isSkeletonVisible();
    const zoom = isZoom();
    if (usingVideo && video && video.readyState >= 2) {
      const { ctx, w: cw, h: ch } = fitCanvas(canvas);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      const VW = video.videoWidth, VH = video.videoHeight;
      const zr0 = zoom ? at('zoomRoi', pos) : null;
      const f = pose.frames[i];
      const lm = at('lm', pos);
      if (zr0) {
        const zr = containRect(cw, ch, 1, 1);
        ctx.drawImage(video, zr0[0] * VW, zr0[1] * VH, zr0[2] * VW, zr0[3] * VH, zr.x, zr.y, zr.w, zr.h);
        if (visible && lm) {
          ctx.save();
          ctx.translate(zr.x, zr.y);
          drawOverlay(ctx, zr.w, zr.h, { ...f, roi: null, lm: lm.map((p) => [(p[0] - zr0[0]) / zr0[2], (p[1] - zr0[1]) / zr0[3], p[2]]) });
          ctx.restore();
        }
      } else {
        const r = containRect(cw, ch, VW, VH);
        ctx.drawImage(video, r.x, r.y, r.w, r.h);
        if (visible) {
          ctx.save();
          ctx.translate(r.x, r.y);
          drawOverlay(ctx, r.w, r.h, { ...f, lm, roi: at('roi', pos) });
          ctx.restore();
        }
      }
      return;
    }
    const key = [i, visible, zoom, canvas.clientWidth, canvas.clientHeight].join('|');
    if (!dirty && key === lastKey) return;
    dirty = false;
    lastKey = key;
    const { ctx, w: cw, h: ch } = fitCanvas(canvas);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    // 人物を追ってズーム：AIに渡した切り出し画像（人物が中央）を、骨格と一緒に大きく表示する
    const f = pose.frames[i];
    const zimg = zoom && f?.zoomRoi ? zoomAt(i) : null;
    if (zimg) {
      const zr = containRect(cw, ch, 1, 1);
      if (zimg.complete && zimg.naturalWidth) ctx.drawImage(zimg, zr.x, zr.y, zr.w, zr.h);
      if (visible) {
        const [rx, ry, rw, rh] = f.zoomRoi;
        const local = { ...f, roi: null, lm: f.lm?.map((p) => [(p[0] - rx) / rw, (p[1] - ry) / rh, p[2]]) };
        ctx.save();
        ctx.translate(zr.x, zr.y);
        drawOverlay(ctx, zr.w, zr.h, local);
        ctx.restore();
      }
      return;
    }
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
    if (state.playing && usingVideo) {
      pos = Math.min(last, video.currentTime * pose.fps);
      dirty = true;
      if (pos >= last || video.ended) {
        pos = last;
        stopVideo();
        state.playing = false;
      }
      onChange();
    } else if (state.playing && lastTs) {
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
      if (video?.src) {
        usingVideo = true;
        video.currentTime = pos / pose.fps;
        video.playbackRate = r;
        // 動画を再生できないときは、コマの画像のパラパラ再生にする
        video.play().catch(() => { usingVideo = false; });
      }
      onChange();
    },
    pause() { stopVideo(); state.playing = false; pos = Math.round(pos); dirty = true; onChange(); },
    /** 範囲の始めからの秒数で移動 */
    seek(t) { stopVideo(); state.playing = false; pos = Math.min(last, Math.max(first, first + t * pose.fps)); dirty = true; onChange(); },
    /** 元の動画のコマ番号で移動 */
    seekFrame(i) { stopVideo(); state.playing = false; pos = Math.min(last, Math.max(first, i)); dirty = true; onChange(); },
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
 * 谷回り・山回り・切り返しを、S字（実際のシュプールのように上から下へ3ターン）または
 * 8の字（右の輪＝右ターン、左の輪＝左ターン、交点＝切り返し）で描く。
 * 1ターンに同じ時間を割り当てるので、フォールライン（○）の位置のずれが、そのままタイミングの差になる。
 * rows: [{ label, color, bySign: {1: {fallFrac}, -1: {fallFrac}}, now: { sign, phase } | null }]（先頭＝お手本）
 */
export function drawTurnShape(canvas, rows, shape) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const now = rows.find((r) => r.now?.sign)?.now ?? { sign: 1, phase: 0 };

  // S字：上から下へ、今のターンを真ん中にして3ターン。真ん中の線を横切る点が切り返し、
  // 一番外側にふくらんだ点がおおよそフォールライン。右ターンは左へ、左ターンは右へふくらむ（ターンの外側）
  const top = 22, bottom = h - 22;
  const turnH = (bottom - top) / 3;
  const A = Math.min(w * 0.3, turnH * 0.9);
  const seq = [-now.sign, now.sign, -now.sign];
  const sPoint = (slot, phase) => [cx - seq[slot] * A * Math.sin(Math.PI * phase), top + (slot + phase) * turnH];

  // 8の字（ジェルノのレムニスケート）：θ=0,π が交点。右の輪 θ∈[0,π]、左の輪 θ∈[π,2π]
  const R8 = Math.min(w * 0.46, h * 0.95);
  const fig8 = (theta, s) => [cx + Math.sin(theta) * R8 * s, cy - Math.sin(theta) * Math.cos(theta) * R8 * s];

  const pathAt = (sign, slot, phase, k) => (shape === 's'
    ? sPoint(slot, phase)
    : fig8((sign > 0 ? 0 : Math.PI) + phase * Math.PI, 1 - k * 0.24));

  const arc = (sign, slot, from, to, k, color, alpha, width) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const n = 40;
    for (let j = 0; j <= n; j++) {
      const [x, y] = pathAt(sign, slot, from + ((to - from) * j) / n, k);
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
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

  // S字はお手本＝太く薄い線、あなた＝細い線で同じ道筋に重ねる。8の字は外側＝お手本、内側＝あなた
  const widths = shape === 's' ? [14, 5] : [6, 6];
  const turnsToDraw = shape === 's' ? [0, 1, 2].map((slot) => [seq[slot], slot]) : [[1, 0], [-1, 0]];
  rows.forEach((r, k) => {
    for (const [sign, slot] of turnsToDraw) {
      const f = r.bySign[sign].fallFrac;
      const dim = shape === 's' && slot !== 1 ? 0.5 : 1; // 今のターン以外は少し薄く
      arc(sign, slot, 0, f, k, r.color, (k === 0 && shape === 's' ? 0.45 : 0.95) * dim, widths[k]); // 谷回り
      arc(sign, slot, f, 1, k, r.color, (k === 0 && shape === 's' ? 0.18 : 0.3) * dim, widths[k]);  // 山回り
      dot(pathAt(sign, slot, f, k), k === 0 && shape === 's' ? 7 : 5, cssVar('--surface'), r.color); // フォールライン
    }
  });

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  if (shape === 's') {
    // 切り返し（真ん中の線を横切る点）と、ターンの向き・谷回り/山回りの目印
    ctx.strokeStyle = cssVar('--border');
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, top - 10);
    ctx.lineTo(cx, bottom + 10);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let slot = 0; slot <= 3; slot++) {
      ctx.fillStyle = cssVar('--text-muted');
      ctx.textAlign = 'left';
      ctx.fillText('切り返し', cx + 6, top + slot * turnH);
    }
    for (let slot = 0; slot < 3; slot++) {
      const side = -seq[slot];
      ctx.fillStyle = cssVar(slot === 1 ? '--text' : '--text-muted');
      ctx.textAlign = side > 0 ? 'left' : 'right';
      const x = cx + side * (A + 14);
      ctx.fillText(seq[slot] > 0 ? '右ターン' : '左ターン', x, top + (slot + 0.5) * turnH);
      if (slot === 1) {
        ctx.fillStyle = cssVar('--text-muted');
        ctx.fillText('↑谷回り', x, top + (slot + 0.25) * turnH);
        ctx.fillText('↓山回り', x, top + (slot + 0.75) * turnH);
      }
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = cssVar('--text-muted');
    ctx.fillText('斜面の下へ ↓', w - 4, h - 8);
  } else {
    ctx.fillStyle = cssVar('--text');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('切り返し', cx, cy - 8);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text-muted');
    ctx.textAlign = 'left';
    ctx.fillText('左ターン', 4, 10);
    ctx.textAlign = 'right';
    ctx.fillText('右ターン', w - 4, 10);
  }

  // 今の位置（S字は真ん中のターン上を動く）
  rows.forEach((r, k) => {
    if (!r.now || !r.now.sign) return;
    dot(pathAt(r.now.sign, 1, r.now.phase, k), k === 0 && shape === 's' ? 9 : 7, r.color, '#ffffff');
  });
}
