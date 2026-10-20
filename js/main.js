import { listModels, getModel, saveModel, deleteModel } from './db.js';
import { extractPose, findPeople, MIN_PERSON, SMALL_PERSON } from './pose.js';
import { fitCanvas, containRect } from './draw.js';
import { analyzeSession, compare, METRICS, PHASES, turnRelative } from './analysis.js';
import { attachSkeleton, drawProfileChart } from './draw.js';
import { createViewer } from './viewer3d.js';
import { IS_BETA, VERSION } from './config.js';
import { resolveSlope } from './terrain.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// プライベートブラウズなどで保存できなかったお手本（ページを閉じると消える）
const memoryModels = new Map();
const allModels = async () => {
  let saved = [];
  try { saved = await listModels(); } catch {}
  return [...saved, ...memoryModels.values()];
};
const findModel = async (id) => memoryModels.get(id) ?? getModel(id);

const state = {
  selectedId: null,
  busy: false,
  cleanups: [],
  urls: [],
  chartData: null,
};

try { state.selectedId = localStorage.getItem('selectedModelId'); } catch {}

$('version').textContent = `v${VERSION}${IS_BETA ? '（試験版）' : ''}`;
if (IS_BETA) document.body.classList.add('beta');

// ---------- お手本の一覧 ----------
async function renderModelList() {
  const models = (await allModels()).sort((a, b) => b.createdAt - a.createdAt);
  if (!models.some((m) => m.id === state.selectedId)) state.selectedId = models[0]?.id ?? null;
  const list = $('model-list');
  if (!models.length) {
    list.innerHTML = '<li class="empty">まだお手本動画がありません。下の「お手本動画を登録する」から追加してください。</li>';
    $('add-model').open = true;
  } else {
    list.innerHTML = models.map((m) => `
      <li class="${m.id === state.selectedId ? 'selected' : ''}">
        <label>
          <input type="radio" name="model" value="${m.id}" ${m.id === state.selectedId ? 'checked' : ''}>
          <span>${esc(m.name)}</span>
          <span class="meta">${m.pose.range ? `${m.pose.range[0].toFixed(1)}〜${m.pose.range[1].toFixed(1)}秒を解析` : `${m.pose.duration.toFixed(1)}秒`} ・ ${new Date(m.createdAt).toLocaleDateString('ja-JP')}${memoryModels.has(m.id) ? ' ・ 一時的（ページを閉じると消えます）' : ''}${m.pose.range ? '' : ' ・ <span class="old">古い版で登録（登録し直してください）</span>'}</span>
        </label>
        <button class="btn small" data-delete="${m.id}">削除</button>
      </li>`).join('');
  }
  updateButtons();
}

$('model-list').addEventListener('change', (e) => {
  if (e.target.name !== 'model') return;
  state.selectedId = e.target.value;
  try { localStorage.setItem('selectedModelId', state.selectedId); } catch {}
  renderModelList();
});

$('model-list').addEventListener('click', async (e) => {
  const id = e.target.dataset?.delete;
  if (!id) return;
  const m = await findModel(id);
  if (!confirm(`「${m?.name}」を削除しますか？`)) return;
  if (memoryModels.has(id)) memoryModels.delete(id);
  else await deleteModel(id);
  renderModelList();
});

// ---------- 解析する範囲と人を選ぶ（3ステップ） ----------
// 戻り値: { target: { t, box } | null（自動で選ぶ）, range: [開始秒, 終了秒], slopeChoice }／ undefined（キャンセル）
const PICK_STEPS = {
  1: {
    title: '解析を始める場面を選んでください',
    hint: 'スライダーを動かして、比べたい滑りが始まる場面に合わせ、「ここから解析」を押してください。動画の最初から使う場合は、そのまま押して大丈夫です。',
    next: 'ここから解析 →',
  },
  2: {
    title: '解析を終える場面を選んでください',
    hint: 'スライダーを動かして、比べたい滑りが終わる場面に合わせ、「ここまで解析」を押してください。最後まで使う場合は、そのまま押して大丈夫です。',
    next: 'ここまで解析 →',
  },
  3: {
    title: '解析する人を選んでください',
    hint: 'スライダーで、解析したい人が大きく映っている場面に動かしてください。黄色い枠が、見つかった人です。',
    next: '解析を開始',
  },
};

// 選んだ人の大きさについての注意（小さいと解析できない・精度が下がる）
const sizeNote = (box) => {
  const pct = Math.round(box.h * 100);
  if (box.h < MIN_PERSON) return `⚠ この場面ではとても小さく映っています（画面の高さの${pct}%）。この大きさでは解析できません。もっと大きく映っている場面が範囲に入るようにしてください。`;
  if (box.h < SMALL_PERSON) return `⚠ 小さめに映っています（画面の高さの${pct}%）。解析はできますが精度が下がります。`;
  return '';
};

function choosePerson(file) {
  return new Promise((resolve) => {
    const dlg = $('pick-dialog'), video = $('pick-video'), canvas = $('pick-canvas');
    const seek = $('pick-seek'), status = $('pick-status'), next = $('pick-next');
    const url = URL.createObjectURL(file);
    let step = 1;
    let range = [0, 0];
    let boxes = [];
    let selected = null; // { t, box }
    let busy = false, pending = false;

    // スライダーの動かせる範囲：ステップ1・2は動画全体、ステップ3は選んだ範囲の中だけ
    const span = () => (step === 3 ? range : [0, video.duration || 0]);
    const setSlider = (t) => {
      const [a, b] = span();
      seek.value = String(Math.round(((t - a) / ((b - a) || 1)) * 1000));
    };
    const onSeek = () => {
      const [a, b] = span();
      video.currentTime = a + (Number(seek.value) / 1000) * (b - a);
    };

    const renderRange = () => {
      const d = video.duration || 1;
      const [a, b] = step === 1 ? [video.currentTime, d] : step === 2 ? [range[0], video.currentTime] : range;
      $('trim-range').style.left = `${(a / d) * 100}%`;
      $('trim-range').style.width = `${(Math.max(0, b - a) / d) * 100}%`;
      $('trim-label').textContent = `解析範囲：${a.toFixed(1)}〜${b.toFixed(1)}秒（${Math.max(0, b - a).toFixed(1)}秒間）・ 現在 ${video.currentTime.toFixed(1)}秒`;
    };

    const draw = () => {
      const { ctx, w: cw, h: ch } = fitCanvas(canvas);
      ctx.clearRect(0, 0, cw, ch);
      if (step !== 3 || !video.videoWidth) return;
      const r = containRect(cw, ch, video.videoWidth, video.videoHeight);
      ctx.translate(r.x, r.y);
      const w = r.w, h = r.h;
      ctx.font = '600 13px system-ui, sans-serif';
      boxes.forEach((b, i) => {
        const isSel = selected && selected.box === b;
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.strokeStyle = isSel ? '#2f9e7a' : '#ffd400';
        ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
        ctx.fillStyle = ctx.strokeStyle;
        const label = isSel ? `${i + 1} ✓` : String(i + 1);
        ctx.fillRect(b.x * w, b.y * h - 18, ctx.measureText(label).width + 12, 18);
        ctx.fillStyle = isSel ? '#fff' : '#000';
        ctx.fillText(label, b.x * w + 6, b.y * h - 4);
      });
    };

    const updateNext = () => {
      next.disabled = step === 3 && !selected;
    };

    const refresh = async () => {
      renderRange();
      if (step !== 3) { draw(); return; }
      if (busy) { pending = true; return; }
      busy = true;
      status.textContent = '人を探しています…（初回はAIモデル 約30MBの読み込みに時間がかかります。Wi-Fiでの利用がおすすめです）';
      try {
        boxes = await findPeople(video);
      } catch (err) {
        boxes = [];
        status.textContent = `人を探せませんでした：${err.message}`;
      }
      // 場面を動かしたら選び直し。1人だけなら自動で選んでおく
      selected = boxes.length === 1 ? { t: video.currentTime, box: boxes[0] } : null;
      if (boxes.length === 1) status.textContent = `この人を解析します（緑の枠）。${sizeNote(boxes[0]) || 'よければ「解析を開始」を押してください。'}`;
      else if (boxes.length > 1) status.textContent = `${boxes.length}人映っています。解析したい人の枠をタップしてください。`;
      else if (!status.textContent.startsWith('人を探せません')) status.textContent = 'この場面では人が見つかりません。スライダーで、人が大きく映っている場面に動かしてください。';
      draw();
      updateNext();
      window.__pick = { boxes, t: video.currentTime }; // 動作確認用
      busy = false;
      if (pending) { pending = false; refresh(); }
    };

    const showStep = (n) => {
      step = n;
      const def = PICK_STEPS[n];
      $('pick-title').textContent = def.title;
      $('pick-hint').textContent = def.hint;
      next.textContent = def.next;
      $('pick-back').hidden = n === 1;
      $('pick-slope-field').hidden = n !== 3;
      $('pick-steps').querySelectorAll('li').forEach((li) => {
        const k = Number(li.dataset.step);
        li.classList.toggle('active', k === n);
        li.classList.toggle('done', k < n);
      });
      status.textContent = '';
      boxes = [];
      selected = null;
      // それぞれのステップで、最初に表示する場面
      const t = n === 1 ? range[0] : n === 2 ? range[1] : (range[0] + range[1]) / 2;
      video.currentTime = Math.min(Math.max(0, t), Math.max(0, (video.duration || 0) - 0.05));
      setSlider(video.currentTime);
      updateNext();
      draw();
    };

    const onNext = () => {
      if (step === 1) {
        if (video.currentTime > video.duration - 1) {
          status.textContent = '開始の場面が動画の最後に近すぎます。もう少し前の場面を選んでください。';
          return;
        }
        range = [video.currentTime, Math.max(range[1], video.currentTime + 1)];
        showStep(2);
      } else if (step === 2) {
        if (video.currentTime < range[0] + 1) {
          status.textContent = `終了の場面は、開始（${range[0].toFixed(1)}秒）より1秒以上あとにしてください。`;
          return;
        }
        range = [range[0], video.currentTime];
        showStep(3);
      } else if (selected) {
        finish({ target: selected, range, slopeChoice: $('pick-slope').value });
      }
    };
    const onBack = () => showStep(step - 1);
    const onClick = (e) => {
      if (step !== 3) return;
      const rect = canvas.getBoundingClientRect();
      const r = containRect(rect.width, rect.height, video.videoWidth, video.videoHeight);
      const x = (e.clientX - rect.left - r.x) / r.w, y = (e.clientY - rect.top - r.y) / r.h;
      const hit = boxes.filter((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (!hit) return;
      selected = { t: video.currentTime, box: hit };
      status.textContent = `${boxes.indexOf(hit) + 1}番の人を選びました（緑の枠）。${sizeNote(hit) || 'よければ「解析を開始」を押してください。'}`;
      draw();
      updateNext();
    };
    const onLoaded = () => {
      $('pick-wrap').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      range = [0, video.duration];
      showStep(1);
    };
    const finish = (value) => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('seeked', refresh);
      seek.removeEventListener('input', onSeek);
      canvas.removeEventListener('click', onClick);
      next.onclick = $('pick-back').onclick = $('pick-cancel').onclick = null;
      dlg.onclose = null;
      dlg.close();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('seeked', refresh);
    seek.addEventListener('input', onSeek);
    canvas.addEventListener('click', onClick);
    next.onclick = onNext;
    $('pick-back').onclick = onBack;
    $('pick-cancel').onclick = () => finish(undefined);
    dlg.onclose = () => finish(undefined);
    $('pick-title').textContent = '動画を読み込んでいます…';
    $('pick-hint').textContent = '';
    status.textContent = '';
    next.disabled = true;
    video.src = url;
    dlg.showModal();
  });
}

// 骨格を1コマも取れなかったときに、理由とどうすればよいかを伝える
function explainIfEmpty(pose, pick) {
  const frames = pose.frames.filter((f) => f.status !== 'skip');
  if (frames.some((f) => f.status === 'ok')) return;
  const [a, b] = pick.range;
  const small = frames.filter((f) => f.status === 'small');
  if (small.length > frames.length / 2) {
    const maxPct = Math.round(Math.max(...small.map((f) => f.size)) * 100);
    throw new Error(`選んだ範囲（${a.toFixed(1)}〜${b.toFixed(1)}秒）では、人物が小さすぎて解析できませんでした（最大でも画面の高さの${maxPct}%）。人物が大きく映っている場面（画面の高さの1/5以上が理想）が入るように範囲を選び直すか、ズームして撮った動画を使ってください。`);
  }
  throw new Error(`選んだ範囲（${a.toFixed(1)}〜${b.toFixed(1)}秒）で、選んだ人の骨格を検出できませんでした。人物の全身がはっきり映っている場面が入るように範囲を選び直してください。`);
}

// ---------- 進捗表示 ----------
function progress(el) {
  el.classList.remove('hidden');
  const bar = el.querySelector('progress'), text = el.querySelector('span');
  return {
    update: (v, msg) => { bar.value = v; text.textContent = msg; },
    done: () => el.classList.add('hidden'),
  };
}

function updateButtons() {
  $('model-add-btn').disabled = state.busy || !$('model-file').files.length;
  $('analyze-btn').disabled = state.busy || !$('user-file').files.length || !state.selectedId;
}
$('model-file').addEventListener('change', () => {
  const f = $('model-file').files[0];
  if (f && !$('model-name').value) $('model-name').value = f.name.replace(/\.[^.]+$/, '');
  updateButtons();
});
$('user-file').addEventListener('change', updateButtons);

// ---------- お手本の登録 ----------
$('model-add-btn').addEventListener('click', async () => {
  const file = $('model-file').files[0];
  const pick = await choosePerson(file);
  if (pick === undefined) return;
  const p = progress($('model-progress'));
  state.busy = true;
  updateButtons();
  try {
    const pose = await extractPose(file, { ...pick, onProgress: p.update });
    explainIfEmpty(pose, pick);
    p.update(1, '撮影地点の斜度を調べています…');
    pose.slope = await resolveSlope(file, pick.slopeChoice);
    analyzeSession(pose); // 人物が取れているかの確認
    const id = crypto.randomUUID();
    const record = { id, name: $('model-name').value.trim() || file.name, createdAt: Date.now(), video: file, pose };
    try {
      await saveModel(record);
    } catch (err) {
      memoryModels.set(id, record);
      alert(`お手本を端末に保存できませんでした（${err?.message ?? '原因不明'}）。プライベートブラウズでは保存できないことがあります。このページを開いている間は使えます。`);
    }
    state.selectedId = id;
    try { localStorage.setItem('selectedModelId', id); } catch {}
    $('model-file').value = '';
    $('model-name').value = '';
    $('add-model').open = false;
    await renderModelList();
  } catch (err) {
    alert(`お手本の登録に失敗しました：${err?.message ?? err}`);
  } finally {
    p.done();
    state.busy = false;
    updateButtons();
  }
});

// ---------- 解析と比較 ----------
$('analyze-btn').addEventListener('click', async () => {
  const file = $('user-file').files[0];
  const pick = await choosePerson(file);
  if (pick === undefined) return;
  const p = progress($('user-progress'));
  state.busy = true;
  updateButtons();
  try {
    const model = await findModel(state.selectedId);
    const userPose = await extractPose(file, { ...pick, onProgress: p.update });
    explainIfEmpty(userPose, pick);
    p.update(1, '撮影地点の斜度を調べています…');
    userPose.slope = await resolveSlope(file, pick.slopeChoice);
    p.update(1, '比較中…');
    const modelAna = analyzeSession(model.pose);
    const userAna = analyzeSession(userPose);
    const result = compare(modelAna, userAna);
    renderResults({ model, modelAna, userFile: file, userPose, userAna, result });
    window.__debug = { userPose, modelPose: model.pose, userAna, modelAna }; // 動作確認用
  } catch (err) {
    alert(`解析に失敗しました：${err?.message ?? err}`);
  } finally {
    p.done();
    state.busy = false;
    updateButtons();
  }
});

// ---------- 結果表示 ----------
const fmt = (v, digits) => (v > 0 ? '+' : '') + v.toFixed(digits);
const slopeText = (s) => (s ? `${s.deg.toFixed(0)}°` : '不明');
const slopeSource = (us, ms) => {
  const src = [us && `あなた：${us.source}`, ms && `お手本：${ms.source}`].filter(Boolean);
  return src.length ? src.join(' ／ ') : '位置情報がありません。解析前に斜面の種類を選べます';
};
const rollText = (ana) => (ana.cameraRoll ? `${Math.abs(ana.cameraRoll).toFixed(0)}°` : 'なし');
const kmh = (ana) => (ana.motion ? `${(ana.motion.speed * 3.6).toFixed(0)}` : '–');
const radius = (ana) => (ana.motion ? `${ana.motion.radius.toFixed(1)}` : '–');

function renderResults({ model, modelAna, userFile, userPose, userAna, result }) {
  state.cleanups.forEach((fn) => fn());
  state.urls.forEach((u) => URL.revokeObjectURL(u));
  state.cleanups = [];
  state.urls = [];

  $('results').classList.remove('hidden');

  const warnings = [
    ...modelAna.warnings.map((w) => `お手本：${w}`),
    ...userAna.warnings.map((w) => `あなた：${w}`),
  ];
  const ms = modelAna.slope, us = userAna.slope;
  if (ms && us && Math.abs(ms.deg - us.deg) >= 8) {
    warnings.push(`撮影した斜面の斜度が大きく違います（あなた ${us.deg.toFixed(0)}° ／ お手本 ${ms.deg.toFixed(0)}°）。斜度で正しい姿勢も変わるため、前後バランスや上体の前傾の比較は参考程度にしてください。`);
  }
  $('warnings').innerHTML = warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');

  $('summary').innerHTML = `
    <div class="stat"><div class="label">お手本との近さ</div><div class="value">${result.similarity}<small> / 100</small></div></div>
    <div class="stat"><div class="label">検出したターン数</div><div class="value">${userAna.fallback ? '–' : userAna.turns.length}<small> （お手本 ${modelAna.fallback ? '–' : modelAna.turns.length}）</small></div></div>
    <div class="stat"><div class="label">1ターンの平均時間</div><div class="value">${userAna.avgTurnDur.toFixed(2)}<small>秒 （お手本 ${modelAna.avgTurnDur.toFixed(2)}秒）</small></div></div>
    <div class="stat"><div class="label">推定速度</div><div class="value">${kmh(userAna)}<small> km/h （お手本 ${kmh(modelAna)} km/h）</small></div><div class="note">体の傾きとターンのリズムから計算した目安です</div></div>
    <div class="stat"><div class="label">推定ターン半径</div><div class="value">${radius(userAna)}<small> m （お手本 ${radius(modelAna)} m）</small></div><div class="note">1ターンの弧の半径（ターンの大きさ）の目安です</div></div>
    <div class="stat"><div class="label">撮影地点の斜度</div><div class="value">${slopeText(us)}<small> （お手本 ${slopeText(ms)}）</small></div><div class="note">${esc(slopeSource(us, ms))}</div></div>
    <div class="stat"><div class="label">カメラの傾き補正</div><div class="value">${rollText(userAna)}<small> （お手本 ${rollText(modelAna)}）</small></div><div class="note">左右のターンの対称性から自動で補正しています</div></div>
    <div class="stat"><div class="label">比較したお手本</div><div class="value" style="font-size:1rem">${esc(model.name)}</div></div>`;

  // 動画と骨格
  const setupVideo = async (videoEl, wrapEl, blob, pose, fromStorage) => {
    wrapEl.style.aspectRatio = `${pose.width} / ${pose.height}`;
    // トリミングした範囲だけを再生する（範囲の外に出たら範囲の始めに戻す）
    const [a, b] = pose.range ?? [0, pose.duration];
    const clampToRange = () => {
      if (videoEl.currentTime < a - 0.05 || videoEl.currentTime > b + 0.05) videoEl.currentTime = a;
    };
    videoEl.onloadedmetadata = () => { videoEl.currentTime = a; };
    videoEl.onplay = clampToRange;
    videoEl.onseeked = () => { if (videoEl.paused) clampToRange(); };
    videoEl.ontimeupdate = () => {
      if (!videoEl.paused && videoEl.currentTime >= b) {
        videoEl.pause();
        videoEl.currentTime = a;
      }
    };
    state.cleanups.push(attachSkeleton(videoEl, wrapEl.querySelector('canvas'), pose, () => $('skeleton-toggle').checked));
    // iPhone（WebKit）では、IndexedDB に保存した動画をそのまま再生すると、
    // 最後まで再生した後やシークした後に止まることがあるため、いったんメモリにコピーしてから再生する
    const src = fromStorage ? new Blob([await blob.arrayBuffer()], { type: blob.type || 'video/mp4' }) : blob;
    const url = URL.createObjectURL(src);
    state.urls.push(url);
    videoEl.src = url;
  };
  setupVideo($('model-video'), $('model-wrap'), model.video, model.pose, true);
  setupVideo($('user-video'), $('user-wrap'), userFile, userPose, false);

  // 連動グラフ：人形の今の局面に合わせて、選んだ指標の値を表示する
  const liveSel = $('live-metric');
  liveSel.innerHTML = METRICS.map((d) => `<option value="${d.key}">${esc(d.label)}（${esc(d.unit)}）</option>`).join('');
  liveSel.value = result.advice.find((a) => a.def.key)?.def.key ?? METRICS[0].key;
  const profileAt = (series, phase) => {
    const x = Math.min(1, Math.max(0, phase)) * (series.length - 1);
    const a = Math.floor(x), b = Math.min(series.length - 1, a + 1);
    return series[a] + (series[b] - series[a]) * (x - a);
  };
  // 今のコマの値：前後3コマの信頼できる値の中央値。なければ平均の推移の値を使う
  const liveValue = (ana, idx, st, key) => {
    if (idx != null && st.sign && !ana.fallback) {
      const vals = [];
      for (let j = Math.max(0, idx - 3); j <= Math.min(ana.raw.length - 1, idx + 3); j++) {
        if (ana.reliable[j]) vals.push(turnRelative(ana.raw[j], st.sign)[key]);
      }
      if (vals.length >= 3) return vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
    }
    return profileAt(ana.profile[key], st.phase);
  };
  let lastLive = null;
  let lastVideoSync = 0;
  const drawLive = (st = lastLive) => {
    if (!st) return;
    lastLive = st;
    const def = METRICS.find((d) => d.key === liveSel.value);
    const u = liveValue(userAna, st.ui, st, def.key);
    const m = liveValue(modelAna, st.mi, st, def.key);
    drawProfileChart($('live-chart'), def, modelAna.profile[def.key], userAna.profile[def.key], { phase: st.phase, user: u, model: m });
    const diff = u - m;
    $('live-values').innerHTML = `あなた <b>${u.toFixed(def.digits)}</b> ／ お手本 <b>${m.toFixed(def.digits)}</b> ${esc(def.unit)}（差 <b class="${Math.abs(diff) >= def.thr ? 'bad-text' : ''}">${fmt(diff, def.digits)}</b>）`;
  };
  liveSel.onchange = () => drawLive();

  // 同じ角度での人形比較
  const viewer = createViewer({
    canvas: $('viewer'), model: modelAna, user: userAna,
    info: $('viewer-info'), seek: $('viewer-seek'), playBtn: $('viewer-play'), speedSel: $('viewer-speed'),
    onSeek: (e) => {
      if (!e) return;
      $('user-video').pause();
      $('model-video').pause();
      $('user-video').currentTime = e.ui / userAna.fps;
      $('model-video').currentTime = e.mi / modelAna.fps;
    },
    onFrame: (st) => {
      drawLive(st);
      // 「実際の滑り」を再生中は、元の動画も同じ場面を追いかける（読み込み中は待つ）
      const uv = $('user-video'), mv = $('model-video');
      const now = performance.now();
      if (st.playing && st.source === 'actual' && st.ui != null && now - lastVideoSync > 100 && !uv.seeking && !mv.seeking) {
        lastVideoSync = now;
        if (!uv.paused) uv.pause();
        if (!mv.paused) mv.pause();
        uv.currentTime = st.ui / userAna.fps;
        mv.currentTime = st.mi / modelAna.fps;
      }
    },
  });
  state.cleanups.push(() => viewer.destroy());
  const segment = (groupId, attr, apply) => {
    $(groupId).onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      $(groupId).querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      apply(b.dataset[attr]);
    };
  };
  segment('view-buttons', 'view', (v) => viewer.setView(v));
  segment('mode-buttons', 'mode', (m) => viewer.setMode(m));
  segment('source-buttons', 'source', (s) => viewer.setSource(s));
  $('source-buttons').querySelector('[data-source="average"]').disabled = !viewer.canAverage;
  $('source-buttons').querySelector('[data-source="actual"]').click();
  $('view-buttons').querySelector('[data-view="front"]').click();
  $('mode-buttons').querySelector('[data-mode="side"]').click();

  $('sync-btn').onclick = () => {
    const mv = $('model-video'), uv = $('user-video');
    const firstTurnTime = (ana) => (ana.fallback ? 0 : ana.turns[0].start / ana.fps);
    mv.currentTime = firstTurnTime(modelAna);
    uv.currentTime = firstTurnTime(userAna);
    uv.playbackRate = 1;
    mv.playbackRate = Math.min(4, Math.max(0.25, modelAna.avgTurnDur / userAna.avgTurnDur || 1));
    mv.play();
    uv.play();
  };

  // 診断情報
  const diagBlock = (label, pose, ana) => {
    const d = pose.diag ?? {};
    const c = {};
    for (const f of pose.frames) if (f.status !== 'skip') c[f.status] = (c[f.status] || 0) + 1;
    const n = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    return `<div class="diag-item"><b>${label}</b>
      <ul>
        <li>解析した範囲：${pose.range ? `${pose.range[0].toFixed(1)}〜${pose.range[1].toFixed(1)}秒` : '範囲の記録なし（古い版で登録）'}（動画全体 ${pose.duration.toFixed(1)}秒）・ 解析したコマ ${n}</li>
        <li>AIに渡した動画の大きさ：${pose.width}×${pose.height}</li>
        <li>計算方法：骨格 ${d.pose ?? '不明'} ／ 人物検出 ${d.detector ?? '不明'}</li>
        <li>骨格を検出できたコマ：${Math.round(((c.ok || 0) / n) * 100)}%（検出 ${c.ok || 0}・見失い ${c.none || 0}・小さすぎ ${c.small || 0}）</li>
        <li>解析時間：${d.seconds ?? '不明'}秒 ・ コマ待ち：${d.frameCallback === null || d.frameCallback === undefined ? '未使用' : d.frameCallback ? 'あり' : 'なし'}</li>
        <li>比較に使ったターン：${ana.turns.length}</li>
      </ul>
      <div class="diag-samples">${(d.samples ?? []).map((src) => `<img src="${src}" alt="AIに渡した画像の見本">`).join('')}</div></div>`;
  };
  $('diag').innerHTML = `<p class="hint">v${VERSION} ・ ${esc(navigator.userAgent)}</p>${diagBlock('あなた', userPose, userAna)}${diagBlock('お手本', model.pose, modelAna)}<p class="hint">URLの末尾に ?cpu=1 を付けて開き直すと、GPUを使わずに計算します（遅くなりますが、精度が変わるか確かめられます）。お手本は登録し直してください。</p>`;

  // アドバイス
  const maxScore = Math.max(...result.advice.map((a) => a.score), 1);
  $('advice').innerHTML = result.advice.length
    ? result.advice.map((a, i) => `
      <li>
        <div class="rank">${i + 1}</div>
        <div class="title">${esc(a.title)}</div>
        <div class="gap"><span>ズレ度 ${a.score.toFixed(1)}</span><span class="bar"><span style="width:${(a.score / maxScore) * 100}%"></span></span></div>
        <div class="meta">${esc(a.def.label)}：お手本との差 ${fmt(a.diff, a.def.digits)}${esc(a.def.unit)}${a.phases.length ? ` ・ ${a.phases.join('、')}で目立ちます` : ''}</div>
        <p class="why">${esc(a.why)}</p>
        <div class="action">→ ${esc(a.action)}</div>
        <div class="cues-label">そのために意識すること</div>
        <ul class="cues">${a.cues.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        <div class="drill"><span>おすすめ練習</span>${esc(a.drill)}</div>
      </li>`).join('')
    : '<li class="good"><div class="title">大きなズレは見つかりませんでした</div><p class="tip">どの指標もお手本との差が目安の範囲内です。細かい違いは下の表とグラフで確認できます。</p></li>';

  // 局面ごとの表
  $('phase-table').innerHTML = `
    <thead><tr><th>指標</th>${PHASES.map((p) => `<th>${p.name}</th>`).join('')}</tr></thead>
    <tbody>${result.table.map((row) => `
      <tr>
        <td>${esc(row.def.label)} <span class="unit">${esc(row.def.unit)}</span></td>
        ${row.phases.map((p) => `<td class="${p.score >= 1 ? 'bad' : ''}" title="あなた ${p.user.toFixed(row.def.digits)} / お手本 ${p.model.toFixed(row.def.digits)}">${fmt(p.diff, row.def.digits)}</td>`).join('')}
      </tr>`).join('')}
    </tbody>`;

  // グラフ
  $('charts').innerHTML = METRICS.map((def) => `
    <div class="chart">
      <div class="name">${esc(def.label)} <span class="unit">${esc(def.unit)}</span></div>
      <div class="desc">${esc(def.desc)}</div>
      <canvas data-key="${def.key}"></canvas>
    </div>`).join('');
  state.chartData = { model: modelAna.profile, user: userAna.profile };
  drawCharts();
  // グラフをクリックすると、その指標を人形モデルと連動して表示する
  $('charts').onclick = (e) => {
    const card = e.target.closest('.chart');
    if (!card) return;
    liveSel.value = card.querySelector('canvas').dataset.key;
    drawLive();
    $('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  $('results').scrollIntoView({ behavior: 'smooth' });
}

function drawCharts() {
  if (!state.chartData) return;
  for (const canvas of $('charts').querySelectorAll('canvas')) {
    const def = METRICS.find((d) => d.key === canvas.dataset.key);
    drawProfileChart(canvas, def, state.chartData.model[def.key], state.chartData.user[def.key]);
  }
}
window.addEventListener('resize', drawCharts);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCharts);

renderModelList();
