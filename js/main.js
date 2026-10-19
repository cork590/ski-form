import { listModels, getModel, saveModel, deleteModel } from './db.js';
import { extractPose, findPeople } from './pose.js';
import { fitCanvas, containRect } from './draw.js';
import { analyzeSession, compare, METRICS, PHASES } from './analysis.js';
import { attachSkeleton, drawProfileChart } from './draw.js';
import { createViewer } from './viewer3d.js';
import { IS_BETA, VERSION } from './config.js';
import { resolveSlope } from './terrain.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  const models = (await listModels()).sort((a, b) => b.createdAt - a.createdAt);
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
          <span class="meta">${m.pose.duration.toFixed(1)}秒 ・ ${new Date(m.createdAt).toLocaleDateString('ja-JP')}</span>
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
  const m = await getModel(id);
  if (!confirm(`「${m?.name}」を削除しますか？`)) return;
  await deleteModel(id);
  renderModelList();
});

// ---------- 解析する人を選ぶ ----------
// 戻り値: { target: { t, box } | null（自動で選ぶ）, range: [開始秒, 終了秒], slopeChoice }／ undefined（キャンセル）
function choosePerson(file) {
  return new Promise((resolve) => {
    const dlg = $('pick-dialog'), video = $('pick-video'), canvas = $('pick-canvas');
    const seek = $('pick-seek'), status = $('pick-status');
    const url = URL.createObjectURL(file);
    let boxes = [];
    let busy = false, pending = false;
    let range = [0, 0];
    const renderRange = () => {
      const d = video.duration || 1;
      $('trim-range').style.left = `${(range[0] / d) * 100}%`;
      $('trim-range').style.width = `${((range[1] - range[0]) / d) * 100}%`;
      const whole = range[0] <= 0.05 && range[1] >= d - 0.05;
      $('trim-label').textContent = `解析範囲：${range[0].toFixed(1)}〜${range[1].toFixed(1)}秒${whole ? '（全体）' : `（${(range[1] - range[0]).toFixed(1)}秒間）`}`;
    };

    const draw = () => {
      const { ctx, w: cw, h: ch } = fitCanvas(canvas);
      ctx.clearRect(0, 0, cw, ch);
      if (!video.videoWidth) return;
      const r = containRect(cw, ch, video.videoWidth, video.videoHeight);
      ctx.translate(r.x, r.y);
      const w = r.w, h = r.h;
      ctx.lineWidth = 2;
      ctx.font = '600 13px system-ui, sans-serif';
      boxes.forEach((b, i) => {
        ctx.strokeStyle = '#ffd400';
        ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
        ctx.fillStyle = '#ffd400';
        ctx.fillRect(b.x * w, b.y * h - 18, 22, 18);
        ctx.fillStyle = '#000';
        ctx.fillText(String(i + 1), b.x * w + 6, b.y * h - 4);
      });
    };
    const refresh = async () => {
      if (busy) { pending = true; return; }
      busy = true;
      status.textContent = '人物を探しています…（初回はAIモデルの読み込みに時間がかかります）';
      try {
        boxes = await findPeople(video);
      } catch (err) {
        boxes = [];
        status.textContent = `人物を探せませんでした：${err.message}`;
      }
      draw();
      if (boxes.length) status.textContent = `${boxes.length}人見つかりました。解析する人の枠をクリックしてください。`;
      else if (!status.textContent.startsWith('人物を探せません')) status.textContent = 'この場面では人物が見つかりません。スライダーで別の場面に動かしてください。';
      window.__pick = { boxes, t: video.currentTime }; // 動作確認用
      busy = false;
      if (pending) { pending = false; refresh(); }
    };
    const onLoaded = () => {
      $('pick-wrap').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      range = [0, video.duration];
      renderRange();
      video.currentTime = Math.min(video.duration / 2, 0.1);
    };
    const onSeek = () => { video.currentTime = (Number(seek.value) / 1000) * (video.duration || 0); };
    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const r = containRect(rect.width, rect.height, video.videoWidth, video.videoHeight);
      const x = (e.clientX - rect.left - r.x) / r.w, y = (e.clientY - rect.top - r.y) / r.h;
      const hit = boxes.filter((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (!hit) return;
      if (video.currentTime < range[0] || video.currentTime > range[1]) {
        status.textContent = '解析範囲の外の場面です。範囲の中の場面で人を選んでください。';
        return;
      }
      finish({ target: { t: video.currentTime, box: hit }, range, slopeChoice: $('pick-slope').value });
    };
    const finish = (value) => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('seeked', refresh);
      seek.removeEventListener('input', onSeek);
      canvas.removeEventListener('click', onClick);
      $('pick-auto').onclick = $('pick-cancel').onclick = null;
      $('trim-start').onclick = $('trim-end').onclick = $('trim-reset').onclick = null;
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
    $('pick-auto').onclick = () => finish({ target: null, range, slopeChoice: $('pick-slope').value });
    $('trim-start').onclick = () => {
      range = [Math.min(video.currentTime, range[1] - 1), range[1]];
      renderRange();
    };
    $('trim-end').onclick = () => {
      range = [range[0], Math.max(video.currentTime, range[0] + 1)];
      renderRange();
    };
    $('trim-reset').onclick = () => {
      range = [0, video.duration];
      renderRange();
    };
    $('pick-cancel').onclick = () => finish(undefined);
    dlg.onclose = () => finish(undefined);
    seek.value = '0';
    boxes = [];
    draw();
    video.src = url;
    dlg.showModal();
  });
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
    p.update(1, '撮影地点の斜度を調べています…');
    pose.slope = await resolveSlope(file, pick.slopeChoice);
    analyzeSession(pose); // 人物が取れているかの確認
    const id = crypto.randomUUID();
    await saveModel({ id, name: $('model-name').value.trim() || file.name, createdAt: Date.now(), video: file, pose });
    state.selectedId = id;
    try { localStorage.setItem('selectedModelId', id); } catch {}
    $('model-file').value = '';
    $('model-name').value = '';
    $('add-model').open = false;
    await renderModelList();
  } catch (err) {
    alert(`お手本の登録に失敗しました：${err.message}`);
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
    const model = await getModel(state.selectedId);
    const userPose = await extractPose(file, { ...pick, onProgress: p.update });
    p.update(1, '撮影地点の斜度を調べています…');
    userPose.slope = await resolveSlope(file, pick.slopeChoice);
    p.update(1, '比較中…');
    const modelAna = analyzeSession(model.pose);
    const userAna = analyzeSession(userPose);
    const result = compare(modelAna, userAna);
    renderResults({ model, modelAna, userFile: file, userPose, userAna, result });
    window.__debug = { userPose, modelPose: model.pose, userAna, modelAna }; // 動作確認用
  } catch (err) {
    alert(`解析に失敗しました：${err.message}`);
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
  const setupVideo = (videoEl, wrapEl, blob, pose) => {
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    videoEl.src = url;
    wrapEl.style.aspectRatio = `${pose.width} / ${pose.height}`;
    state.cleanups.push(attachSkeleton(videoEl, wrapEl.querySelector('canvas'), pose, () => $('skeleton-toggle').checked));
  };
  setupVideo($('model-video'), $('model-wrap'), model.video, model.pose);
  setupVideo($('user-video'), $('user-wrap'), userFile, userPose);

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
