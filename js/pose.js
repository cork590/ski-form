// 動画から骨格を抽出する（ブラウザ内で完結）
// 小さく映った人物にも対応するため、
//   1. 物体検出で人物を探す（見つからなければ画面を分割して探す）
//   2. 人物の周りを切り出して拡大し、骨格を検出する
//   3. 次のコマは、直前の骨格の位置を追いかけて切り出す
const VERSION_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const BUNDLE = `${VERSION_PATH}/vision_bundle.mjs`;
const WASM = `${VERSION_PATH}/wasm`;
// 大型版（heavy）を標準にする。小さく映った人やヘルメット・ゴーグル姿でも骨格を取りやすい。
// ダウンロードは約30MBと大きいが、速さはほぼ変わらない。?model=full で従来版
const POSE_MODEL = new URLSearchParams(location.search).get('model') !== 'full'
  ? 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task'
  : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
const DETECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite';

const CROP = 512; // 切り出した画像の大きさ（px）
const MARGIN = 1.6; // 人物の大きさに対する切り出し範囲の倍率
const REDETECT_EVERY = 15; // 追跡中も、このコマ数ごとに物体検出で位置を確かめる
export const MIN_PERSON = 0.04; // 人物の高さがこれ未満（画面比）だと小さすぎて解析しない
export const SMALL_PERSON = 0.06; // これ未満は解析はするが精度が下がる

let modelsPromise = null;
// 診断用：実際に使われた計算方法（GPU/CPU）。URLに ?cpu=1 を付けるとCPUで計算する
export const diagnostics = { pose: null, detector: null };
export const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const params = new URLSearchParams(location.search);
const FORCE_CPU = params.has('cpu');
// 動作確認用：?slow=ミリ秒 で1コマの解析をわざと遅くする（iPhone の遅さを再現する）
const SLOW_MS = Number(params.get('slow')) || 0;
// iPhone ではシークしても画像が更新されないコマが多いため、再生しながら取り込む（?mode=play / ?mode=seek で切り替え）
const usePlayback = (video) => !!video.requestVideoFrameCallback
  && (params.get('mode') === 'play' || (IS_IOS && params.get('mode') !== 'seek'));
// VIDEO モードはタイムスタンプが単調増加である必要があるので、動画をまたいで積み上げる
let tsBase = 0;

function getModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      // 重いライブラリは解析時に読み込む（画面の表示を止めないため）
      const { FilesetResolver, PoseLandmarker, ObjectDetector } = await import(BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const create = async (factory, opts, name) => {
        if (!FORCE_CPU) {
          try {
            const m = await factory.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } });
            diagnostics[name] = 'GPU';
            return m;
          } catch {}
        }
        diagnostics[name] = 'CPU';
        return await factory.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
      };
      const poseOpts = (runningMode) => ({
        baseOptions: { modelAssetPath: POSE_MODEL },
        runningMode,
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.5,
      });
      // VIDEO モード：前のコマの骨格を手がかりに追い続けるので、ヘルメットやゴーグルで顔が見えにくくても強い。
      // ただし切り出し位置が変わると見当違いの場所を探すことがあるため、
      // おかしな結果のときは IMAGE モード（毎回探し直す）でやり直す
      const pose = await create(PoseLandmarker, poseOpts('VIDEO'), 'pose');
      const poseImage = await create(PoseLandmarker, poseOpts('IMAGE'), 'pose');
      const detector = await create(ObjectDetector, {
        baseOptions: { modelAssetPath: DETECT_MODEL },
        runningMode: 'IMAGE',
        scoreThreshold: 0.2,
        maxResults: 8,
        categoryAllowlist: ['person'],
      }, 'detector');
      return { pose, poseImage, detector };
    })();
    modelsPromise.catch(() => { modelsPromise = null; });
  }
  return modelsPromise;
}

function once(target, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`動画の読み込みがタイムアウトしました（${event}）`)), timeoutMs);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * iPhone（Safari）は、一時停止中にシークしても画面の画像が更新されないことがある。
 * 一瞬だけ再生して新しいコマが表示されたら止めることで、今の位置の画像を表示させる
 */
export async function showCurrentFrame(video) {
  if (!IS_IOS || !video.paused || !video.src || video.nudging) return;
  video.nudging = true; // この間の play/pause/timeupdate は利用者の操作として扱わない
  const t = video.currentTime;
  try {
    const shown = new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
    await video.play();
    await shown;
  } catch {}
  video.pause();
  // 再生で少し進んだ分は気にしない（1コマ未満）。大きく進んだときだけ戻す
  if (Math.abs(video.currentTime - t) > 0.1) video.currentTime = t;
  setTimeout(() => { video.nudging = false; }, 50);
}

const r4 = (v) => Math.round(v * 10000) / 10000;

// シーク後、新しいコマが実際に描画されるまで待つ。
// iPhone（WebKit）では seeked の直後に描くと、前のコマが残っていることがある。
// 一時停止中のシークで通知が来ないブラウザもあるので、最初の1回で確かめ、来なければ以後は待たない
let frameCallbackWorks = null;
async function seekTo(video, t) {
  video.currentTime = t;
  await once(video, 'seeked');
  if (!video.requestVideoFrameCallback || frameCallbackWorks === false) return;
  const fired = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), frameCallbackWorks ? 250 : 150);
    video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(true); });
  });
  if (frameCallbackWorks === null) frameCallbackWorks = fired;
}

// 画面全体で人物を探し、見つからなければ重なりのあるタイルに分けて探す（小さな人物向け）
function detectPeople(detector, video, W, H, tileCanvas, tiles = true) {
  const boxes = [];
  const collect = (res, ox, oy, sx, sy) => {
    for (const d of res.detections) {
      const b = d.boundingBox;
      boxes.push({ x: ox + b.originX * sx, y: oy + b.originY * sy, w: b.width * sx, h: b.height * sy, score: d.categories[0].score });
    }
  };
  collect(detector.detect(video), 0, 0, 1, 1);
  if (boxes.length || !tiles) return boxes;

  const t = Math.round(Math.min(W, H) * 0.6);
  const ctx = tileCanvas.getContext('2d');
  tileCanvas.width = tileCanvas.height = Math.min(t, 640);
  const s = t / tileCanvas.width;
  for (let y = 0; y < H; y += t * 0.75) {
    for (let x = 0; x < W; x += t * 0.75) {
      const ox = Math.min(x, W - t), oy = Math.min(y, H - t);
      ctx.drawImage(video, ox, oy, t, t, 0, 0, tileCanvas.width, tileCanvas.height);
      collect(detector.detect(tileCanvas), ox, oy, s, s);
    }
  }
  return boxes;
}

// 追跡中は、直前の位置に近く大きさも近い候補だけを選ぶ（別の人に乗り移らないように）。
// 追跡していないときは、いちばん大きく映っている人物を選ぶ
function pickPerson(boxes, prev) {
  if (!boxes.length) return null;
  if (prev) {
    const near = boxes
      .map((b) => ({ b, d: Math.hypot(b.x + b.w / 2 - prev.cx, b.y + b.h / 2 - prev.cy), r: b.h / prev.h }))
      .filter(({ d, r }) => d < prev.h * 0.8 && r > 0.6 && r < 1.6)
      .sort((a, b) => a.d - b.d);
    return near.length ? near[0].b : null;
  }
  return boxes.reduce((a, b) => (b.h > a.h ? b : a));
}

/** 動画の今の場面に映っている人物の枠（0〜1の座標）を返す。解析する人を選んでもらうのに使う */
export async function findPeople(video, { tiles = true } = {}) {
  const { detector } = await getModels();
  const W = video.videoWidth, H = video.videoHeight;
  return detectPeople(detector, video, W, H, document.createElement('canvas'), tiles)
    .map((b) => ({ x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H }));
}

// 返ってきた骨格が、追跡中の人のものか。
// 切り出しは追跡中の人を中心にしているので、骨格の中心が切り出し範囲の中央付近にあり、
// 大きさが人物の枠（板やストックを含むので骨格より大きめ）と大きく違わなければ同じ人とみなす。
// ※前のコマの骨格の大きさと比べる方式は、一度小さく誤検出すると正しい骨格まで捨て続けたのでやめた
function isSamePerson(full, roi, W, H) {
  const vis = full.filter((p) => p[2] > 0.3);
  if (vis.length < 6) return true;
  const xs = vis.map((p) => p[0] * W), ys = vis.map((p) => p[1] * H);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const h = Math.max(...ys) - Math.min(...ys);
  const offCenter = Math.hypot(cx - roi.cx, cy - roi.cy) / roi.size;
  const ratio = h / roi.h;
  return offCenter < 0.3 && ratio > 0.35 && ratio < 1.8;
}

const roiFromBox = (b) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2, size: Math.max(b.w, b.h) * MARGIN, h: b.h });

/**
 * @param {Blob} file 動画ファイル
 * @returns {Promise<{fps:number,duration:number,width:number,height:number,frames:{t:number,lm:number[][]|null,wl:number[][]|null,size:number,roi:number[]|null,status:string}[]}>}
 *   status: 'ok' | 'small'（人物が小さすぎる） | 'none'（人物が見つからない） | 'skip'（解析範囲外）
 */
export async function extractPose(file, { fps = 15, target = null, range = null, onProgress = () => {} } = {}) {
  onProgress(0, 'AIモデルを読み込み中…（初回は約50MBをダウンロードするため、Wi-Fiでの利用がおすすめです）');
  const { pose, poseImage, detector } = await getModels();

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  // iPhone（Safari）は、ページに置いていない動画や一度も再生していない動画だと、
  // シークしても画像が更新されないことがある。見えない大きさでページに置いておく
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(video);
  video.src = url;
  // 画像が更新されているかの確認用（同じ画像が続いたコマを数える）
  const probe = document.createElement('canvas');
  probe.width = probe.height = 16;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  let lastSig = '';
  let stale = 0;
  const crop = document.createElement('canvas');
  crop.width = crop.height = CROP;
  const cropCtx = crop.getContext('2d', { willReadFrequently: true });
  const tileCanvas = document.createElement('canvas');

  try {
    await once(video, 'loadeddata');
    // 一瞬だけ再生して止める（iPhone でシーク後の画像が描かれるようにするため）
    try {
      await video.play();
      video.pause();
    } catch {}
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('動画の長さを取得できませんでした。');
    const W = video.videoWidth, H = video.videoHeight;
    const startedAt = performance.now();
    // 結果画面でパラパラ再生するための、各コマの小さな画像（幅360px）
    const thumb = document.createElement('canvas');
    thumb.width = 360;
    thumb.height = Math.round((360 * H) / W);
    const thumbCtx = thumb.getContext('2d');
    const samples = []; // 診断用：AIに渡した切り出し画像の見本

    const total = Math.floor(duration * fps);
    // 指定された範囲の外は解析しない（時間とコマ番号の対応を保つため、空のコマで埋めておく）
    const first = range ? Math.max(0, Math.ceil(range[0] * fps)) : 0;
    const last = range ? Math.min(total - 1, Math.floor(range[1] * fps)) : total - 1;
    const frames = Array.from({ length: total }, (_, i) => ({ t: i / fps, lm: null, wl: null, size: 0, roi: null, status: 'skip' }));
    const count = last - first + 1;
    let ts = tsBase;
    let done = 0;

    // 画像が前のコマから変わっていなければ数える（iPhone で起きる問題の確認用）
    const checkStale = () => {
      probeCtx.drawImage(video, 0, 0, 16, 16);
      const px = probeCtx.getImageData(0, 0, 16, 16).data;
      let sig = '';
      for (let k = 0; k < px.length; k += 16) sig += px[k].toString(36);
      if (sig === lastSig) stale++;
      lastSig = sig;
    };

    // 方式1：1コマずつシークして解析する（PC向け。前後どちらにも追跡できる）
    const step = async (i, st) => {
      await seekTo(video, i / fps);
      checkStale();
      process(i, st);
    };

    // 今 video に表示されているコマを i 番目として解析する（同期処理）
    const process = (i, st) => {
      const t = i / fps;
      if (SLOW_MS) { const end = performance.now() + SLOW_MS; while (performance.now() < end); }

      if (!st.roi || st.sinceDetect >= REDETECT_EVERY) {
        const person = pickPerson(detectPeople(detector, video, W, H, tileCanvas), st.roi);
        if (person) st.roi = roiFromBox(person);
        else if (!st.roi || st.sinceDetect >= REDETECT_EVERY * 2) st.roi = null;
        st.sinceDetect = 0;
      }
      st.sinceDetect++;

      const roi = st.roi;
      thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
      const frame = { t, lm: null, wl: null, size: roi ? r4(roi.h / H) : 0, roi: null, status: 'none', img: thumb.toDataURL('image/jpeg', 0.7) };
      if (roi && roi.h / H < MIN_PERSON) {
        frame.status = 'small';
        // 人物が近づいて大きくなったらすぐ解析できるよう、小さいうちは毎コマ探し直す
        st.sinceDetect = REDETECT_EVERY;
      } else if (roi) {
        const x0 = roi.cx - roi.size / 2, y0 = roi.cy - roi.size / 2;
        cropCtx.fillStyle = '#808080';
        cropCtx.fillRect(0, 0, CROP, CROP);
        cropCtx.drawImage(video, x0, y0, roi.size, roi.size, 0, 0, CROP, CROP);
        if (samples.length < 4 && i % 40 === 0) samples.push(crop.toDataURL('image/jpeg', 0.6));
        ts += Math.round(1000 / fps);
        // 切り出し画像内の座標 → 元の動画の座標（0〜1）
        const toFull = (res) => {
          const l = res.landmarks?.[0], w = res.worldLandmarks?.[0];
          return l && w ? { lm: l, wl: w, full: l.map((p) => [(x0 + p.x * roi.size) / W, (y0 + p.y * roi.size) / H, p.visibility ?? 1]) } : null;
        };
        const ok = (r) => r && isSamePerson(r.full, roi, W, H);
        let r = toFull(pose.detectForVideo(crop, ts));
        if (!ok(r)) {
          const retry = toFull(poseImage.detect(crop));
          if (ok(retry)) { r = retry; retried++; }
        }
        const lm = r?.lm, wl = r?.wl, full = r?.full ?? null;
        if (full && !ok(r)) {
          // 骨格が追跡中の位置から大きく飛んだ＝近くを通った別の人に乗り移った可能性が高い。
          // このコマは使わず、次のコマで物体検出から探し直す（直前の位置に近い人を優先）
          st.sinceDetect = REDETECT_EVERY;
          rejected++;
        } else if (full) {
          frame.lm = full.map((p) => p.map(r4));
          frame.wl = wl.map((p) => [r4(p.x), r4(p.y), r4(p.z)]);
          frame.roi = [x0 / W, y0 / H, roi.size / W, roi.size / H].map(r4);
          frame.status = 'ok';
          st.lastIdx = i;

          // 次のコマは、今回の骨格を囲む範囲を追いかける
          const vis = full.filter((p) => p[2] > 0.3);
          if (vis.length >= 8) {
            const xs = vis.map((p) => p[0] * W), ys = vis.map((p) => p[1] * H);
            const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
            const next = roiFromBox(box);
            // 急な拡大縮小を抑える（骨格の誤検出で範囲が暴れないように）
            // 1コマ（1/15秒）で人物の大きさはほとんど変わらないので、変化を1割までに抑える
            const clamp = (v, ref) => Math.min(ref * 1.1, Math.max(ref * 0.9, v));
            st.roi = { cx: next.cx, cy: next.cy, size: clamp(roi.size * 0.5 + next.size * 0.5, roi.size), h: clamp(roi.h * 0.5 + box.h * 0.5, roi.h) };
            frame.size = r4(st.roi.h / H);
          }
        } else {
          noPose++;
          st.roi = null; // 見失ったら次のコマで探し直す
        }
      }
      frames[i] = frame;
      done++;
      onProgress(done / count, `骨格を解析中… ${done} / ${count}`);
    };

    // 方式2：再生しながら取り込む。解析が追いつくよう再生速度を自動で調整し、
    // 取りこぼしたコマは 'gap'（後で前後から補間）にする
    let mode = 'seek';
    let rejected = 0, noPose = 0, retried = 0; // 診断用：別人と判断して捨てた数／骨格が返ってこなかった数
    let gaps = 0;
    const playRange = (fromIdx, toIdx, st) => new Promise((resolve) => {
      let lastIdx = fromIdx - 1;
      const rate = 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        video.pause();
        for (let k = lastIdx + 1; k <= toIdx; k++) { frames[k] = { ...frames[k], status: 'gap' }; gaps++; done++; }
        resolve();
      };
      const watchdog = { id: 0 };
      const arm = () => { clearTimeout(watchdog.id); watchdog.id = setTimeout(finish, 4000); };
      const onFrame = (_now, meta) => {
        if (finished) return;
        arm();
        const i = Math.round(meta.mediaTime * fps);
        if (i > lastIdx && i <= toIdx) {
          // 次のコマに進まないよう、すぐ一時停止してから解析する（iPhone は解析が遅いため）
          video.pause();
          for (let k = lastIdx + 1; k < i; k++) { frames[k] = { ...frames[k], status: 'gap' }; gaps++; done++; }
          ts = Math.max(ts + 1, tsBase + Math.round(meta.mediaTime * 1000));
          process(i, st);
          lastIdx = i;
          if (i >= toIdx) { clearTimeout(watchdog.id); finish(); return; }
          video.requestVideoFrameCallback(onFrame);
          video.play().catch(finish);
          return;
        }
        if (i >= toIdx || video.ended) { clearTimeout(watchdog.id); finish(); return; }
        video.requestVideoFrameCallback(onFrame);
      };
      (async () => {
        video.pause();
        video.currentTime = fromIdx / fps;
        await once(video, 'seeked');
        video.playbackRate = rate;
        video.requestVideoFrameCallback(onFrame);
        arm();
        try { await video.play(); } catch { finish(); }
      })();
    });

    // 選んだ人物がいる場面から後ろへ、続いて前へさかのぼって追跡する
    const start = target ? Math.min(last, Math.max(first, Math.round(target.t * fps))) : first;
    const startRoi = () => (target
      ? roiFromBox({ x: target.box.x * W, y: target.box.y * H, w: target.box.w * W, h: target.box.h * H })
      : null);
    if (usePlayback(video)) {
      mode = 'play';
      // 方式2（iPhone）：再生しながら、表示されたコマを取り込む。
      // 選んだ場面から最後まで → 範囲の始めから選んだ場面まで の順に再生する
      await playRange(start, last, { roi: startRoi(), sinceDetect: target ? 0 : Infinity });
      if (start > first) await playRange(first, start - 1, { roi: startRoi(), sinceDetect: REDETECT_EVERY });
    } else {
      const forward = { roi: startRoi(), sinceDetect: target ? 0 : Infinity };
      for (let i = start; i <= last; i++) await step(i, forward);
      const backward = { roi: startRoi(), sinceDetect: 0 };
      for (let i = start - 1; i >= first; i--) await step(i, backward);
    }
    tsBase = ts + 1000;
    return {
      fps, duration, width: W, height: H, frames, range: [first / fps, last / fps],
      diag: {
        seconds: Math.round((performance.now() - startedAt) / 100) / 10,
        pose: diagnostics.pose, detector: diagnostics.detector,
        frameCallback: frameCallbackWorks, samples, stale, mode, gaps, rejected, noPose, retried,
      },
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
