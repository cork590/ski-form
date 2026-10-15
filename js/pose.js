// MediaPipe Pose Landmarker で動画から骨格を抽出する（ブラウザ内で完結）
const BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

let landmarkerPromise = null;
// VIDEO モードはタイムスタンプが単調増加である必要があるので、動画をまたいで積み上げる
let tsBase = 0;

function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      // 重いライブラリは解析時に読み込む（画面の表示を止めないため）
      const { FilesetResolver, PoseLandmarker } = await import(BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      try {
        return await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch {
        return await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

function once(target, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`動画の読み込みがタイムアウトしました（${event}）`)), timeoutMs);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * @param {Blob} file 動画ファイル
 * @returns {Promise<{fps:number,duration:number,width:number,height:number,frames:{t:number,lm:number[][]|null,wl:number[][]|null}[]}>}
 */
export async function extractPose(file, { fps = 15, onProgress = () => {} } = {}) {
  onProgress(0, 'AIモデルを読み込み中…');
  const landmarker = await getLandmarker();

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata');
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('動画の長さを取得できませんでした。');

    const frames = [];
    const total = Math.floor(duration * fps);
    for (let i = 0; i < total; i++) {
      const t = i / fps;
      video.currentTime = t;
      await once(video, 'seeked');
      const res = landmarker.detectForVideo(video, tsBase + Math.round(t * 1000));
      const lm = res.landmarks?.[0];
      const wl = res.worldLandmarks?.[0];
      frames.push({
        t,
        lm: lm ? lm.map((p) => [r4(p.x), r4(p.y), r4(p.visibility ?? 1)]) : null,
        wl: wl ? wl.map((p) => [r4(p.x), r4(p.y), r4(p.z)]) : null,
      });
      onProgress((i + 1) / total, `骨格を解析中… ${i + 1} / ${total}`);
    }
    tsBase += Math.round(duration * 1000) + 1000;
    return { fps, duration, width: video.videoWidth, height: video.videoHeight, frames };
  } finally {
    URL.revokeObjectURL(url);
  }
}
