// 骨格データ → 体基準の指標 → ターン検出 → お手本との比較・アドバイス
// 座標は MediaPipe の worldLandmarks（腰中心・メートル単位・y軸は下向き）を使う。
// カメラはおおむね水平に構えている前提で、y軸を重力方向とみなす。

export const LM = {
  nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28,
  lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

const UP = [0, -1, 0];
const DEG = 180 / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
const mid = (a, b) => scale(add(a, b), 0.5);
const horiz = (a) => [a[0], 0, a[2]];
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const cos = dot(u, v) / (len(u) * len(v) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}

// 検出できなかったフレームを前後から線形補間
function fillGaps(frames, key) {
  const valid = frames.map((f, i) => (f[key] ? i : -1)).filter((i) => i >= 0);
  if (!valid.length) return null;
  let vi = 0;
  return frames.map((f, i) => {
    if (f[key]) return f[key];
    while (vi < valid.length && valid[vi] < i) vi++;
    const p = vi > 0 ? valid[vi - 1] : null;
    const n = vi < valid.length ? valid[vi] : null;
    if (p === null) return frames[n][key];
    if (n === null) return frames[p][key];
    const w = (i - p) / (n - p);
    return frames[p][key].map((pt, k) => pt.map((v, d) => v + (frames[n][key][k][d] - v) * w));
  });
}

function smoothSeq(seq, win) {
  const h = Math.floor(win / 2);
  return seq.map((_, i) => {
    const a = Math.max(0, i - h), b = Math.min(seq.length - 1, i + h), n = b - a + 1;
    return seq[i].map((pt, k) => pt.map((_, d) => {
      let s = 0;
      for (let j = a; j <= b; j++) s += seq[j][k][d];
      return s / n;
    }));
  });
}

function smooth1d(arr, win) {
  const h = Math.floor(win / 2);
  return arr.map((_, i) => {
    const a = Math.max(0, i - h), b = Math.min(arr.length - 1, i + h);
    let s = 0;
    for (let j = a; j <= b; j++) s += arr[j];
    return s / (b - a + 1);
  });
}

// 1フレーム分の、カメラの向きに左右されにくい「体基準」の指標
export function frameMetrics(w) {
  const hipMid = mid(w[LM.lHip], w[LM.rHip]);
  const shMid = mid(w[LM.lSh], w[LM.rSh]);
  const ankMid = mid(w[LM.lAnk], w[LM.rAnk]);

  // 体の左右軸 h（左腰→右腰、水平面）と前方軸 f
  const h = norm(horiz(sub(w[LM.rHip], w[LM.lHip])));
  let f = norm(cross(h, UP));
  const headFwd = sub(w[LM.nose], mid(w[LM.lEar], w[LM.rEar]));
  if (dot(f, headFwd) < 0) f = scale(f, -1);

  const torso = sub(shMid, hipMid);
  const torsoLen = len(torso) || 1;
  const leg = sub(hipMid, ankMid);
  const legLen = mean([
    len(sub(w[LM.lHip], w[LM.lKnee])) + len(sub(w[LM.lKnee], w[LM.lAnk])),
    len(sub(w[LM.rHip], w[LM.rKnee])) + len(sub(w[LM.rKnee], w[LM.rAnk])),
  ]) || 1;

  // 肩ラインの腰ラインに対するねじれ（+ = 右肩が前 = 胸が左を向く）
  const shLine = norm(horiz(sub(w[LM.rSh], w[LM.lSh])));
  const shoulderRot = Math.atan2(dot(shLine, f), dot(shLine, h)) * DEG;

  const wrMid = mid(w[LM.lWr], w[LM.rWr]);
  // 板の向き（かかと→つま先）
  const foot = horiz(add(sub(w[LM.lFoot], w[LM.lHeel]), sub(w[LM.rFoot], w[LM.rHeel])));

  return {
    legLateral: Math.atan2(dot(leg, h), dot(leg, UP)) * DEG, // + = 右へ傾く
    torsoLateral: Math.atan2(dot(torso, h), dot(torso, UP)) * DEG,
    torsoForward: Math.atan2(dot(torso, f), dot(torso, UP)) * DEG,
    kneeFlexL: 180 - angleAt(w[LM.lHip], w[LM.lKnee], w[LM.lAnk]),
    kneeFlexR: 180 - angleAt(w[LM.rHip], w[LM.rKnee], w[LM.rAnk]),
    hipFlex: 180 - mean([
      angleAt(w[LM.lSh], w[LM.lHip], w[LM.lKnee]),
      angleAt(w[LM.rSh], w[LM.rHip], w[LM.rKnee]),
    ]),
    shoulderRot,
    foreAft: (dot(leg, f) / legLen) * 100,
    stance: len(horiz(sub(w[LM.rAnk], w[LM.lAnk]))) / (len(sub(w[LM.rHip], w[LM.lHip])) || 1),
    handsFwd: (dot(sub(wrMid, shMid), f) / torsoLen) * 100,
    handsHeight: (dot(sub(wrMid, hipMid), UP) / torsoLen) * 100,
    hipYaw: Math.atan2(f[0], f[2]) * DEG,
    footYaw: Math.atan2(foot[0], foot[2]) * DEG,
    legLen,
  };
}

// 左右の傾きの符号が入れ替わる点を「切り替え」とみなしてターンに分割
export function detectTurns(sig, fps, thr = 4, minDur = 0.4) {
  const crossings = [];
  let state = 0;
  for (let i = 0; i < sig.length; i++) {
    const s = sig[i] > thr ? 1 : sig[i] < -thr ? -1 : 0;
    if (s !== 0 && s !== state) {
      if (state !== 0) {
        let j = i;
        while (j > 0 && Math.sign(sig[j - 1]) === s) j--;
        crossings.push(j);
      }
      state = s;
    }
  }
  const turns = [];
  for (let k = 0; k + 1 < crossings.length; k++) {
    const start = crossings[k], end = crossings[k + 1];
    if ((end - start) / fps < minDur) continue;
    turns.push({ start, end, sign: Math.sign(mean(sig.slice(start, end + 1))) || 1 });
  }
  return turns;
}

// 人物が小さすぎたコマの割合と、その時間帯（1秒以上続いたもの）
function frameQuality(frames, fps) {
  const small = frames.map((f) => f.status === 'small');
  const ranges = [];
  for (let i = 0; i < small.length;) {
    if (!small[i]) { i++; continue; }
    let j = i;
    while (j + 1 < small.length && small[j + 1]) j++;
    if ((j - i + 1) / fps >= 1) ranges.push(`${(i / fps).toFixed(1)}〜${(j / fps).toFixed(1)}秒`);
    i = j + 1;
  }
  return {
    smallRatio: small.filter(Boolean).length / (frames.filter((f) => f.status !== 'skip').length || 1),
    smallRanges: ranges.slice(0, 3).join('、') || '短い区間が点在',
  };
}

const N_POINTS = 41;
const G = 9.81;

// 角度の不連続（±180°）をつなげる
function unwrap(arr) {
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    let d = arr[i] - arr[i - 1];
    d -= Math.round(d / 360) * 360;
    out.push(out[i - 1] + d);
  }
  return out;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

// 内傾角は遠心力とのつり合い（tanθ = v·ω / g）で決まるので、
// ターン中の向きの変化 Δφ と時間 T から ω = Δφ/T を出し、速度 v と半径 R = v/ω を推定する
function estimateTurnMotion(turn, lateral, hipYaw, footYaw, fps) {
  const n = turn.end - turn.start;
  const T = n / fps;
  const a = turn.start + Math.round(n * 0.2), b = turn.start + Math.round(n * 0.8);
  const tanMean = mean(lateral.slice(a, b + 1).map((v) => Math.tan(Math.min(70, Math.abs(v)) / DEG)));
  const span = (arr) => {
    const s = arr.slice(turn.start, turn.end + 1);
    return Math.max(...s) - Math.min(...s);
  };
  const headingChange = Math.max(15, Math.min(180, (span(hipYaw) + span(footYaw)) / 2));
  const omega = headingChange / DEG / T;
  const speed = (G * tanMean) / omega;
  return { T, inclination: Math.atan(tanMean) * DEG, headingChange, speed, radius: speed / omega };
}

function resample(arr, n = N_POINTS) {
  if (arr.length === 1) return Array(n).fill(arr[0]);
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * (arr.length - 1);
    const a = Math.floor(x), b = Math.min(arr.length - 1, a + 1);
    return arr[a] + (arr[b] - arr[a]) * (x - a);
  });
}

// ターンの向き（右/左）をそろえて、外足・内足・外向などに読み替える（s: +1 = 右ターン）
export function turnRelative(m, s) {
  return {
    inclination: m.legLateral * s,
    angulation: (m.legLateral - m.torsoLateral) * s,
    outsideKnee: s > 0 ? m.kneeFlexL : m.kneeFlexR,
    insideKnee: s > 0 ? m.kneeFlexR : m.kneeFlexL,
    hipFlex: m.hipFlex,
    torsoForward: m.torsoForward,
    foreAft: m.foreAft,
    counterRot: m.shoulderRot * s,
    stance: m.stance,
    handsFwd: m.handsFwd,
    handsHeight: m.handsHeight,
  };
}

function turnSeries(raw, turn) {
  const out = {};
  for (const def of METRICS) out[def.key] = [];
  for (let i = turn.start; i <= turn.end; i++) {
    const v = turnRelative(raw[i], turn.sign);
    for (const def of METRICS) out[def.key].push(v[def.key]);
  }
  for (const k in out) out[k] = resample(out[k]);
  return out;
}

// 画面内での脚の傾き（腰−足首、+ = 画面の右へ傾く）を、右ターン・左ターンそれぞれで平均し、その中間を返す
function estimateRoll(seq, turns, valid) {
  const per = { 1: [], [-1]: [] };
  for (const t of turns) {
    const angs = [];
    for (let i = t.start; i <= t.end; i++) {
      if (!valid[i]) continue;
      const w = seq[i];
      const leg = sub(mid(w[LM.lHip], w[LM.rHip]), mid(w[LM.lAnk], w[LM.rAnk]));
      angs.push(Math.atan2(leg[0], -leg[1]) * DEG);
    }
    if (angs.length) per[t.sign].push(mean(angs));
  }
  if (!per[1].length || !per[-1].length) return 0;
  return (mean(per[1]) + mean(per[-1])) / 2;
}

// 向き（板と腰の平均）が、その動画で最も多く向いている方向＝斜面の下 を横切る瞬間をフォールラインとする。
// 横切らないターンは、体が一番深く傾いた瞬間で代用する。turn.fall（コマ番号）と turn.fallFrac（0〜1）を書き込む
function markFallLines(turns, lateral, hipYaw, footYaw, valid) {
  const heading = hipYaw.map((h, i) => (h + footYaw[i]) / 2);
  const vals = heading.filter((_, i) => valid[i]);
  const down = median(vals.length ? vals : heading);
  for (const t of turns) {
    const n = t.end - t.start;
    let fall = -1;
    // 切り返し直後と直前の1割は除いて探す
    const a = t.start + Math.round(n * 0.1), b = t.end - Math.round(n * 0.1);
    for (let i = a; i < b; i++) {
      if (Math.sign(heading[i] - down) !== Math.sign(heading[i + 1] - down)) {
        fall = Math.abs(heading[i] - down) < Math.abs(heading[i + 1] - down) ? i : i + 1;
        break;
      }
    }
    if (fall < 0) {
      let best = a;
      for (let i = a; i <= b; i++) if (Math.abs(lateral[i]) > Math.abs(lateral[best])) best = i;
      fall = best;
      t.fallBy = 'inclination';
    } else {
      t.fallBy = 'heading';
    }
    t.fall = fall;
    t.fallFrac = (fall - t.start) / (n || 1);
  }
}

export function analyzeSession(pose) {
  const { frames, fps } = pose;
  const warnings = [];
  const inRange = frames.filter((f) => f.status !== 'skip');
  // 'gap' は再生しながら取り込んだときに取りこぼしたコマ。前後から補間できるので有効とみなす
  const validRatio = inRange.filter((f) => f.wl || f.status === 'gap').length / (inRange.length || 1);
  const wl = fillGaps(frames, 'wl');
  if (!wl) throw new Error('動画から人物を検出できませんでした。全身が映っている動画を使ってください。');
  const quality = frameQuality(frames, fps);
  const okFrames = frames.filter((f) => f.status === 'ok');
  const tiny = okFrames.filter((f) => f.size && f.size < 0.06).length;
  if (okFrames.length && tiny / okFrames.length > 0.5) {
    warnings.push(`解析できたコマの多くで、人物が小さく映っています（画面の高さの6%未満）。結果の精度は低めです。ズームして大きく撮った動画だと精度が上がります。`);
  }
  if (quality.smallRatio > 0.15) {
    warnings.push(`人物が小さすぎて解析できないコマが ${Math.round(quality.smallRatio * 100)}% ありました（${quality.smallRanges}）。ズームして、人物が画面の高さの1/5以上になるように撮ると精度が上がります。`);
  }
  if (validRatio < 0.6) {
    warnings.push(`骨格を検出できたコマは全体の ${Math.round(validRatio * 100)}% でした。検出できた区間だけで比較しています。`);
  }

  // 骨格を検出できなかった区間（補間しただけのコマ）が多いターンは使わない
  const valid = frames.map((f) => !!f.wl || f.status === 'gap');
  const pass = (seq) => {
    const raw = seq.map(frameMetrics);
    const lateral = smooth1d(raw.map((m) => m.legLateral), 7);
    const detected = detectTurns(lateral, fps);
    const turns = detected.filter((t) => {
      let n = 0;
      for (let i = t.start; i <= t.end; i++) n += valid[i] ? 1 : 0;
      return n / (t.end - t.start + 1) >= 0.7;
    });
    return { raw, lateral, detected, turns };
  };

  // カメラの傾き補正：右ターンと左ターンの傾きは左右対称になるはずなので、
  // 平均が片側にずれていれば、その分カメラが傾いているとみなして骨格を回転させる
  // 傾いているとターンの区切り位置もずれるので、補正→区切り直しを数回くり返して収束させる
  const base = smoothSeq(wl, 5);
  const rotate = (deg) => {
    const c = Math.cos(-deg / DEG), sn = Math.sin(-deg / DEG);
    return base.map((w) => w.map(([x, y, z]) => [x * c - y * sn, x * sn + y * c, z]));
  };
  let smoothed = base;
  let res = pass(smoothed);
  let cameraRoll = 0;
  for (let k = 0; k < 4; k++) {
    const r = estimateRoll(smoothed, res.turns, valid);
    if (Math.abs(r) < 0.5) break;
    const next = cameraRoll + r;
    if (Math.abs(next) > 20) {
      warnings.push(`カメラが大きく傾いている可能性があります（約${Math.abs(next).toFixed(0)}°）。自動補正の範囲を超えているため補正していません。`);
      cameraRoll = 0;
      smoothed = base;
      res = pass(smoothed);
      break;
    }
    cameraRoll = next;
    smoothed = rotate(cameraRoll);
    res = pass(smoothed);
  }
  if (Math.abs(cameraRoll) < 1) {
    cameraRoll = 0;
    smoothed = base;
    res = pass(smoothed);
  }
  const { raw, lateral, detected } = res;
  let turns = res.turns;
  if (detected.length > turns.length) {
    warnings.push(`検出した ${detected.length} ターンのうち、骨格がうまく取れなかった ${detected.length - turns.length} ターンは比較から外しました。`);
  }
  let fallback = false;
  if (!turns.length) {
    fallback = true;
    warnings.push('ターンの切り替えを検出できなかったため、動画全体を1区間として比較しています。2ターン以上映っている動画だと精度が上がります。');
    const first = Math.max(0, valid.indexOf(true));
    const last = Math.max(first, valid.lastIndexOf(true));
    turns = [{ start: first, end: last, sign: Math.sign(mean(lateral.slice(first, last + 1))) || 1 }];
  }

  // 体の向きが平均から大きく外れたコマ（左右の取り違えなど）は、1コマごとの表示に使わない
  const cs = raw.reduce((a, m) => [a[0] + Math.sin(m.hipYaw / DEG), a[1] + Math.cos(m.hipYaw / DEG)], [0, 0]);
  const canonYaw = Math.atan2(cs[0], cs[1]) * DEG;
  const reliable = raw.map((m, i) => {
    let d = m.hipYaw - canonYaw;
    d -= Math.round(d / 360) * 360;
    return valid[i] && Math.abs(d) < 75;
  });

  const hipYaw = smooth1d(unwrap(raw.map((m) => m.hipYaw)), 7);
  const footYaw = smooth1d(unwrap(raw.map((m) => m.footYaw)), 7);
  const motions = fallback ? [] : turns.map((t) => estimateTurnMotion(t, lateral, hipYaw, footYaw, fps));

  // 谷回り・山回りのタイミング：各ターンでフォールライン（板と腰の向きが斜面の真下を向く瞬間）を求める
  if (!fallback) markFallLines(turns, lateral, hipYaw, footYaw, valid);
  const timing = fallback ? null : {
    fallFrac: mean(turns.map((t) => t.fallFrac)),
    valleySec: mean(turns.map((t) => (t.fall - t.start) / fps)),
    mountainSec: mean(turns.map((t) => (t.end - t.fall) / fps)),
  };
  const motion = motions.length ? {
    speed: median(motions.map((m) => m.speed)),
    radius: median(motions.map((m) => m.radius)),
    perTurn: motions,
  } : null;

  const cycles = turns.map((t) => turnSeries(raw, t));
  const profile = {};
  for (const def of METRICS) {
    profile[def.key] = Array.from({ length: N_POINTS }, (_, i) => mean(cycles.map((c) => c[def.key][i])));
  }
  return {
    fps, raw, wl: smoothed, lateral, turns, profile, fallback, warnings, motion, validRatio,
    cameraRoll, slope: pose.slope ?? null, reliable,
    avgTurnDur: mean(turns.map((t) => (t.end - t.start) / fps)),
    timing,
  };
}

export const PHASES = [
  { name: '切り替え直後', a: 0, b: 0.2 },
  { name: 'ターン前半', a: 0.2, b: 0.5 },
  { name: 'ターン後半', a: 0.5, b: 0.8 },
  { name: '切り替え前', a: 0.8, b: 1 },
];

// thr = この差を超えたら「ズレている」とみなす目安
// アドバイスは「状態（title/why）→ 指示（action）→ 意識すること（cues）→ 練習（drill）」の順に示す
export const METRICS = [
  {
    key: 'foreAft', label: '前後バランス', unit: '%', thr: 4, digits: 0,
    desc: '腰が足首より前にあるほど＋（脚の長さ比）',
    less: {
      title: '後傾（重心が後ろ）', action: '重心を前に移しましょう',
      why: '腰がお手本より後ろにあり、かかと寄りに乗っています。板の先端が浮いて、ターンの始めに板をとらえにくくなります。',
      cues: ['すねをブーツのタン（前側）に軽く押し当て続ける', '切り替えで、おへそを次のターンの前方へ送り出す', '手を体の前に構え、視線は数ターン先へ'],
      drill: 'ストックを両手で体の前に横向きに持って滑る（手が前に出て、前に乗る感覚がつかめます）',
    },
    more: {
      title: '前に乗りすぎ', action: '重心を足裏の真ん中に戻しましょう',
      why: '腰がお手本より前に出ています。板の後ろが抜けやすく、ターン後半が不安定になります。',
      cues: ['足裏全体、特に土踏まずで雪面を感じる', '上体を前に倒しすぎず、腰をブーツの真上に置く'],
      drill: '緩斜面の直滑降で、つま先・かかと・真ん中と乗る位置を変え、真ん中の感覚を確かめる',
    },
  },
  {
    key: 'inclination', label: '内傾角', unit: '°', thr: 6, digits: 0,
    desc: '体全体がターンの内側へ傾いている角度',
    less: {
      title: '内傾が浅い（体が立っている）', action: '内傾を深めましょう',
      why: 'ターン中に体を内側へ傾ける量がお手本より少なく、板の角付けが弱くなっています。',
      cues: ['ターンの始めから、腰をターンの内側（円の中心）へ移していく', 'スピードを怖がらず、遠心力に体を預ける', '外足に乗ったまま、内足をたたんで傾きを作る'],
      drill: '中斜面の大回りで、ターンの内側の手を雪面に近づけるつもりで滑る（やりすぎに注意）',
    },
    more: {
      title: '内傾が深すぎる（内倒気味）', action: '内倒を直して外足に乗りましょう',
      why: '体全体がお手本以上に内側へ倒れています。外足への荷重が抜け、板がずれやすくなります。',
      cues: ['外側の肩を少し下げ、上体を外足の上に残す', 'ターン中は外足に体重の大部分を乗せる', '内側の手を前に出し、肩が内側に落ちないようにする'],
      drill: '内足を少し浮かせ、外足一本でターンする',
    },
  },
  {
    key: 'angulation', label: '外傾（くの字）', unit: '°', thr: 5, digits: 0,
    desc: '脚の傾きに対して上体が外側に残っている角度',
    less: {
      title: '外傾が足りない（上体ごと倒れている）', action: '外傾（くの字）を作りましょう',
      why: '脚と一緒に上体も倒れており、くの字姿勢が作れていません。外足に体重を乗せきれず、内倒しやすい状態です。',
      cues: ['外側の肩を少し下げ、みぞおちを外足の上に置く', '腰から下は内側へ、上体は谷側に残す', '外側の手を下げ、内側の手を少し上げる'],
      drill: 'ストックを両手で横に持ち、斜面と平行に保ったまま滑る',
    },
    more: {
      title: '上体を折りすぎ', action: '上体の折り曲げを控えましょう',
      why: '上体の外傾がお手本より大きく、脚（腰）の内傾が不足している可能性があります。',
      cues: ['上体だけを折らず、脚と腰の傾きでターンを作る', '肩のラインは雪面と平行になる程度で十分'],
      drill: '大回りで、腰をターンの内側へ動かすことだけに集中して滑る',
    },
  },
  {
    key: 'outsideKnee', label: '外足の膝の曲げ', unit: '°', thr: 8, digits: 0,
    desc: '外足の膝の屈曲角（大きいほど深く曲がっている）',
    less: {
      title: '外足が伸び気味', action: '外足をもう少し曲げて使いましょう',
      why: '外足の膝の曲げがお手本より浅く、棒立ちに近い状態です。雪面からの圧を吸収できません。',
      cues: ['足首と膝を一緒に曲げ、すねの角度を保つ', '雪面からの圧を膝のクッションで受け止める', 'ターン後半に外足を突っ張らない'],
      drill: '小さな凹凸のある緩斜面で、凹凸を脚で吸収しながら滑る',
    },
    more: {
      title: '外足が曲がりすぎ', action: '外足を伸ばして雪面を押しましょう',
      why: '外足が深く曲がりすぎて、雪面を押す力が弱くなっています。',
      cues: ['ターン前半から中盤にかけて、外足をじわっと伸ばしながら板を押し出す', '曲げた脚で耐えるのではなく、伸ばす力で板をたわませる'],
      drill: 'ターンのたびに「伸ばして押す・曲げて抜く」とリズムを声に出して滑る',
    },
  },
  {
    key: 'insideKnee', label: '内足の膝の曲げ', unit: '°', thr: 10, digits: 0,
    desc: '内足の膝の屈曲角',
    less: {
      title: '内足が突っ張っている', action: '内足をたたみましょう',
      why: '内足の膝の曲げが浅く、内足が突っ張っています。体を内側へ傾けにくくなります。',
      cues: ['内足の膝を胸に引き寄せるように曲げる', '両すねの傾きをそろえる'],
      drill: 'ターン中に内足の板の後ろを少し浮かせて滑る',
    },
    more: {
      title: '内足をたたみすぎ', action: '内足にも軽く乗りましょう',
      why: '内足をお手本より深く曲げています。内足が遊ぶと、バランスが崩れやすくなります。',
      cues: ['内足を浮かせすぎず、雪面に軽く触れておく', '両足の幅と傾きを一定に保つ'],
      drill: '緩斜面のパラレルターンで、両足に同時に乗る意識で滑る',
    },
  },
  {
    key: 'hipFlex', label: '股関節の曲げ', unit: '°', thr: 8, digits: 0,
    desc: '上体と太ももの角度（大きいほど深く曲がっている）',
    less: {
      title: '腰高（股関節が使えていない）', action: '股関節を曲げて低い姿勢を作りましょう',
      why: '股関節の曲げがお手本より浅く、腰が高い姿勢です。バランスを崩しやすくなります。',
      cues: ['お辞儀をするように、股関節から上体を前に傾ける', '腰を落とすのではなく、股関節・膝・足首を同じ割合で曲げる'],
      drill: '滑り出す前に、止まった状態で3つの関節を曲げた姿勢を確認してから滑る',
    },
    more: {
      title: '腰が引けている', action: '腰の引けを直しましょう',
      why: '股関節が深く曲がり、お尻が後ろに引けている可能性があります。後傾につながります。',
      cues: ['骨盤を立て、腰をブーツの真上に戻す', 'お尻を後ろに突き出さず、足首を曲げてすねを前に倒す'],
      drill: 'ストックを両手で体の前に横向きに持って滑る',
    },
  },
  {
    key: 'torsoForward', label: '上体の前傾', unit: '°', thr: 6, digits: 0,
    desc: '上体が前に傾いている角度',
    less: {
      title: '上体が起きている', action: '上体を少し前に傾けましょう',
      why: '上体の前傾がお手本より少なく、後ろに乗りやすい姿勢です。',
      cues: ['胸を少し前に出し、みぞおちを板の真ん中より前に置く', '視線を足元ではなく、進行方向の先へ向ける'],
      drill: '両手を前に出し、手が常に視界に入る状態をキープして滑る',
    },
    more: {
      title: '上体が前に倒れすぎ', action: '上体を少し起こしましょう',
      why: '上体が前に倒れすぎています。股関節だけで前傾を作ると、腰が引けやすくなります。',
      cues: ['背中を丸めず、胸を軽く張る', '前傾は股関節だけでなく、足首の曲げで作る'],
      drill: '緩斜面で、足首の曲げ伸ばしだけでリズムを取りながら滑る',
    },
  },
  {
    key: 'counterRot', label: '外向（上体の向き）', unit: '°', thr: 6, digits: 0,
    desc: '腰に対して肩がターンの外側を向いている角度',
    less: {
      title: '外向が不足（ローテーション気味）', action: '外向を強めましょう',
      why: '肩が腰と一緒にターン方向へ回り込んでいます。板が回りすぎて、次のターンへの切り替えが遅れます。',
      cues: ['胸とおへそを、ターン中ずっと谷側（ターンの外側）へ向け続ける', '上体は谷を向いたまま、脚だけが左右に回るイメージ', '内側の手を少し前に出し、肩が回り込むのを防ぐ'],
      drill: '小回りで、谷側の目標物を見続け、体の正面を谷に向けたまま脚だけでターンする',
    },
    more: {
      title: '外向が強すぎ', action: '外向を弱めましょう',
      why: '上体をお手本以上に外側へひねっています。ひねりすぎると、板の回転を止めてしまいます。',
      cues: ['上体のひねりは自然な範囲にとどめる', 'ターン前半は、体の正面を進行方向に合わせる'],
      drill: '大回りで、上体と板の向きをそろえて滑る',
    },
  },
  {
    key: 'stance', label: 'スタンス幅', unit: '×腰幅', thr: 0.25, digits: 2,
    desc: '両足首の幅（腰幅に対する比率）',
    less: {
      title: 'スタンスが狭い', action: 'スタンスを少し広げましょう',
      why: '両足の幅がお手本より狭く、左右の足を独立して使いにくい状態です。',
      cues: ['腰幅を目安に足を開く', '左右の足を別々に動かす'],
      drill: '緩斜面で、左右の板を交互に少し持ち上げながら滑る',
    },
    more: {
      title: 'スタンスが広い', action: 'スタンスを少し狭めましょう',
      why: '両足の幅がお手本より広く、内足が邪魔になりやすい状態です。',
      cues: ['腰幅を目安に足を寄せる', '両足の板を平行に保つ'],
      drill: '緩斜面で、両足の間隔を一定に保ったままパラレルターンをする',
    },
  },
  {
    key: 'handsFwd', label: '手の前後位置', unit: '%', thr: 12, digits: 0,
    desc: '肩に対する手の前後位置（胴の長さ比）',
    less: {
      title: '手が後ろに下がっている', action: '手を前に出しましょう',
      why: '手の位置がお手本より後ろにあります。後傾やローテーションの原因になります。',
      cues: ['両手が常に視界に入る位置に構える', 'ストックを突くとき以外も、肘を軽く前に出しておく'],
      drill: 'ストックを両手で体の前に横向きに持って滑る',
    },
    more: {
      title: '手が前に出すぎ', action: '手の位置を少し戻しましょう',
      why: '腕を前に伸ばしすぎています。肩や腕に力が入りやすくなります。',
      cues: ['肘を軽く曲げ、力を抜いて構える'],
      drill: '腕の力を抜き、ストックを軽く握ったまま緩斜面を滑る',
    },
  },
  {
    key: 'handsHeight', label: '手の高さ', unit: '%', thr: 12, digits: 0,
    desc: '腰を0、肩を100としたときの手の高さ',
    less: {
      title: '手が下がっている', action: '手の位置を上げましょう',
      why: '手の位置がお手本より低いです。手が下がると、上体が丸まりやすくなります。',
      cues: ['おへそ〜胸の高さを目安に構える', '手のひらを軽く下に向け、前に差し出す'],
      drill: '両手で見えないお盆を持っているつもりで滑る',
    },
    more: {
      title: '手が上がりすぎ', action: '手を少し下げましょう',
      why: '手の位置がお手本より高く、肩に力が入っている可能性があります。',
      cues: ['肩の力を抜き、肘を軽く下げる'],
      drill: '滑る前に肩を一度すくめてストンと落とし、力の抜けた位置で構える',
    },
  },
];

function phaseMean(series, ph) {
  const vals = series.filter((_, i) => {
    const x = i / (series.length - 1);
    return x >= ph.a && x <= ph.b;
  });
  return mean(vals);
}

export function compare(model, user) {
  const table = METRICS.map((def) => ({
    def,
    phases: PHASES.map((ph) => {
      const m = phaseMean(model.profile[def.key], ph);
      const u = phaseMean(user.profile[def.key], ph);
      const diff = u - m;
      return { phase: ph, model: m, user: u, diff, score: Math.abs(diff) / def.thr };
    }),
  }));

  const advice = [];
  for (const row of table) {
    const worst = row.phases.reduce((a, b) => (b.score > a.score ? b : a));
    if (worst.score < 1) continue;
    const dir = worst.diff > 0 ? 'more' : 'less';
    const hit = row.phases.filter((p) => p.score >= 1 && Math.sign(p.diff) === Math.sign(worst.diff));
    advice.push({
      def: row.def, dir, score: worst.score, diff: worst.diff,
      phases: hit.map((p) => p.phase.name),
      ...row.def[dir],
    });
  }

  const ratio = model.avgTurnDur ? user.avgTurnDur / model.avgTurnDur : 1;
  if (!model.fallback && !user.fallback && Math.abs(ratio - 1) > 0.25) {
    const slower = ratio > 1;
    advice.push({
      def: { label: 'ターンのリズム', unit: '秒', digits: 2 },
      dir: slower ? 'more' : 'less',
      score: Math.abs(ratio - 1) / 0.25,
      diff: user.avgTurnDur - model.avgTurnDur,
      phases: [],
      ...(slower ? {
        title: 'ターンが長い（リズムが遅い）', action: 'ターンのリズムを速めましょう',
        why: '1ターンにかかる時間がお手本より長いです。',
        cues: ['切り替えを素早くし、次のターンへ早めに入る', 'ストックを突くタイミングでリズムを刻む'],
        drill: 'ストックを突くたびに「イチ、ニ」と声に出し、一定のリズムで小回りする',
      } : {
        title: 'ターンが短い（リズムが速い）', action: 'ターンをじっくり仕上げましょう',
        why: '1ターンにかかる時間がお手本より短いです。',
        cues: ['板がしっかり回り切るまで待つ', 'ターン後半を急がず、丁寧に仕上げる'],
        drill: '大回りで、1ターンごとに「もう少し待つ」を意識して滑る',
      }),
    });
  }
  advice.sort((a, b) => b.score - a.score);

  const avgScore = mean(table.map((r) => Math.min(3, mean(r.phases.map((p) => p.score)))));
  const similarity = Math.round(Math.max(0, Math.min(100, 100 - avgScore * 30)));
  return { table, advice, similarity };
}
