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

// ターンの向き（右/左）をそろえて、外足・内足・外向などに読み替える
function turnSeries(raw, turn) {
  const s = turn.sign; // +1 = 右ターン（右が内側）
  const out = {};
  for (const def of METRICS) out[def.key] = [];
  for (let i = turn.start; i <= turn.end; i++) {
    const m = raw[i];
    const v = {
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
    for (const def of METRICS) out[def.key].push(v[def.key]);
  }
  for (const k in out) out[k] = resample(out[k]);
  return out;
}

export function analyzeSession(pose) {
  const { frames, fps } = pose;
  const warnings = [];
  const validRatio = frames.filter((f) => f.wl).length / (frames.length || 1);
  const wl = fillGaps(frames, 'wl');
  if (!wl) throw new Error('動画から人物を検出できませんでした。全身が映っている動画を使ってください。');
  if (validRatio < 0.6) {
    warnings.push(`骨格を検出できたフレームが ${Math.round(validRatio * 100)}% と少なめです。結果の精度が下がっている可能性があります。`);
  }

  const smoothed = smoothSeq(wl, 5);
  const raw = smoothed.map(frameMetrics);
  const lateral = smooth1d(raw.map((m) => m.legLateral), 7);
  let turns = detectTurns(lateral, fps);
  let fallback = false;
  if (!turns.length) {
    fallback = true;
    warnings.push('ターンの切り替えを検出できなかったため、動画全体を1区間として比較しています。2ターン以上映っている動画だと精度が上がります。');
    turns = [{ start: 0, end: raw.length - 1, sign: Math.sign(mean(lateral)) || 1 }];
  }

  const hipYaw = smooth1d(unwrap(raw.map((m) => m.hipYaw)), 7);
  const footYaw = smooth1d(unwrap(raw.map((m) => m.footYaw)), 7);
  const motions = fallback ? [] : turns.map((t) => estimateTurnMotion(t, lateral, hipYaw, footYaw, fps));
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
    fps, raw, wl: smoothed, lateral, turns, profile, fallback, warnings, motion,
    avgTurnDur: mean(turns.map((t) => (t.end - t.start) / fps)),
  };
}

export const PHASES = [
  { name: '切り替え直後', a: 0, b: 0.2 },
  { name: 'ターン前半', a: 0.2, b: 0.5 },
  { name: 'ターン後半', a: 0.5, b: 0.8 },
  { name: '切り替え前', a: 0.8, b: 1 },
];

// thr = この差を超えたら「ズレている」とみなす目安
export const METRICS = [
  {
    key: 'foreAft', label: '前後バランス', unit: '%', thr: 4, digits: 0,
    desc: '腰が足首より前にあるほど＋（脚の長さ比）',
    less: { title: '後傾（重心が後ろ）', tip: '腰がお手本より後ろにあり、かかと寄りに乗っています。すねをブーツのタンに押し当てて、切り替えでは体を板の前方へ送り出しましょう。' },
    more: { title: '前に乗りすぎ', tip: '腰がお手本より前に出ています。テールが抜けやすくなるので、足裏全体で踏める位置まで重心を戻しましょう。' },
  },
  {
    key: 'inclination', label: '内傾角', unit: '°', thr: 6, digits: 0,
    desc: '体全体がターンの内側へ傾いている角度',
    less: { title: '内傾が浅い（体が立っている）', tip: 'ターン中に体を内側へ傾ける量がお手本より少ないです。外足に乗ったまま腰をターンの内側へ移動させ、切り替えでは早めに次のターン方向へ体を送り込みましょう。' },
    more: { title: '内傾が深すぎる（内倒気味）', tip: '体全体がお手本以上に内側へ倒れています。外足への荷重が抜けやすいので、上体を谷側に残して外足の上に乗り続けましょう。' },
  },
  {
    key: 'angulation', label: '外傾（くの字）', unit: '°', thr: 5, digits: 0,
    desc: '脚の傾きに対して上体が外側に残っている角度',
    less: { title: '外傾が足りない（上体ごと倒れている）', tip: '脚と一緒に上体も倒れており、くの字姿勢が作れていません。外側の肩を少し下げ、みぞおちを外足の上に置くイメージで上体を谷側へ残しましょう。' },
    more: { title: '上体を折りすぎ', tip: '上体の外傾がお手本より大きく、腰が内側に入っていない可能性があります。脚（腰）の内傾を使い、上体の折り曲げに頼りすぎないようにしましょう。' },
  },
  {
    key: 'outsideKnee', label: '外足の膝の曲げ', unit: '°', thr: 8, digits: 0,
    desc: '外足の膝の屈曲角（大きいほど深く曲がっている）',
    less: { title: '外足が伸び気味', tip: '外足の膝の曲げがお手本より浅いです。棒立ちになると雪面からの圧を吸収できません。足首と膝を連動させて、外足を柔らかく使いましょう。' },
    more: { title: '外足が曲がりすぎ', tip: '外足が深く曲がりすぎて、雪面を押す力が弱くなっています。ターン中盤以降は外足を伸ばしながら、板をしっかり押し出しましょう。' },
  },
  {
    key: 'insideKnee', label: '内足の膝の曲げ', unit: '°', thr: 10, digits: 0,
    desc: '内足の膝の屈曲角',
    less: { title: '内足が突っ張っている', tip: '内足の膝の曲げが浅く、内足が突っ張っています。内足はたたむように曲げて、両足の傾きをそろえましょう。' },
    more: { title: '内足をたたみすぎ', tip: '内足をお手本より深く曲げています。内足が遊ぶとバランスが崩れやすいので、内足にも軽く乗っておきましょう。' },
  },
  {
    key: 'hipFlex', label: '股関節の曲げ', unit: '°', thr: 8, digits: 0,
    desc: '上体と太ももの角度（大きいほど深く曲がっている）',
    less: { title: '腰高（股関節が使えていない）', tip: '股関節の曲げがお手本より浅いです。お辞儀をするように股関節から上体を前に倒し、低く安定したポジションを作りましょう。' },
    more: { title: '腰が引けている', tip: '股関節が深く曲がり、お尻が後ろに引けている可能性があります。骨盤を立てて、腰をブーツの真上に戻しましょう。' },
  },
  {
    key: 'torsoForward', label: '上体の前傾', unit: '°', thr: 6, digits: 0,
    desc: '上体が前に傾いている角度',
    less: { title: '上体が起きている', tip: '上体の前傾がお手本より少なく、後ろに乗りやすい姿勢です。胸を少し前に出し、目線は進行方向の先へ向けましょう。' },
    more: { title: '上体が前に倒れすぎ', tip: '上体が前に倒れすぎています。股関節だけを折ると腰が引けやすいので、足首・膝・股関節をバランスよく曲げましょう。' },
  },
  {
    key: 'counterRot', label: '外向（上体の向き）', unit: '°', thr: 6, digits: 0,
    desc: '腰に対して肩がターンの外側を向いている角度',
    less: { title: '外向が不足（ローテーション気味）', tip: '肩が腰と一緒にターン方向へ回り込んでいます。胸とおへそを少し谷側（ターンの外側）へ向け続けましょう。' },
    more: { title: '外向が強すぎ', tip: '上体をお手本以上に外側へひねっています。ひねりすぎると板の回転を止めてしまうので、自然な範囲に抑えましょう。' },
  },
  {
    key: 'stance', label: 'スタンス幅', unit: '×腰幅', thr: 0.25, digits: 2,
    desc: '両足首の幅（腰幅に対する比率）',
    less: { title: 'スタンスが狭い', tip: '両足の幅がお手本より狭いです。腰幅程度を目安に足を開き、左右の足を独立して使えるようにしましょう。' },
    more: { title: 'スタンスが広い', tip: '両足の幅がお手本より広いです。広すぎると内足が邪魔になりやすいので、少し狭めましょう。' },
  },
  {
    key: 'handsFwd', label: '手の前後位置', unit: '%', thr: 12, digits: 0,
    desc: '肩に対する手の前後位置（胴の長さ比）',
    less: { title: '手が後ろに下がっている', tip: '手の位置がお手本より後ろにあり、後傾やローテーションの原因になります。両手を常に視界に入る体の前に構えましょう。' },
    more: { title: '手が前に出すぎ', tip: '腕を前に伸ばしすぎています。肘を軽く曲げ、楽に構えられる位置に戻しましょう。' },
  },
  {
    key: 'handsHeight', label: '手の高さ', unit: '%', thr: 12, digits: 0,
    desc: '腰を0、肩を100としたときの手の高さ',
    less: { title: '手が下がっている', tip: '手の位置がお手本より低いです。手が下がると上体が丸まりやすいので、おへそ〜胸の高さを目安に構えましょう。' },
    more: { title: '手が上がりすぎ', tip: '手の位置がお手本より高く、肩に力が入っている可能性があります。肩の力を抜いて少し下げましょう。' },
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
      title: slower ? 'ターンが長い（リズムが遅い）' : 'ターンが短い（リズムが速い）',
      tip: slower
        ? '1ターンにかかる時間がお手本より長いです。切り替えを素早くし、次のターンへ早めに入っていきましょう。'
        : '1ターンにかかる時間がお手本より短いです。ターンを急がず、板がしっかり回り切るまで待ちましょう。',
    });
  }
  advice.sort((a, b) => b.score - a.score);

  const avgScore = mean(table.map((r) => Math.min(3, mean(r.phases.map((p) => p.score)))));
  const similarity = Math.round(Math.max(0, Math.min(100, 100 - avgScore * 30)));
  return { table, advice, similarity };
}
