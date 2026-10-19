// 撮影地点の位置情報と斜度
// iPhone・Android のカメラは、動画のメタデータに位置を ISO 6709 形式（例: +36.8620+138.7266+1595.690/）で記録する

const ISO6709 = /([+-]\d{1,2}\.\d{2,})([+-]\d{1,3}\.\d{2,})([+-]\d+(?:\.\d+)?)?(?:CRS[^/]*)?\//;

/** 動画ファイルの先頭と末尾（メタデータがある場所）から撮影位置を探す。見つからなければ null */
export async function readLocation(file) {
  const decode = async (blob) => new TextDecoder('latin1').decode(await blob.arrayBuffer());
  const head = await decode(file.slice(0, 1 << 20));
  const m = head.match(ISO6709) ?? (await decode(file.slice(Math.max(0, file.size - (4 << 20))))).match(ISO6709);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// 中心と東西南北の標高から斜度を求める
function slopeFrom(c, n, s, e, w, d) {
  const gx = (e - w) / (2 * d), gy = (n - s) / (2 * d);
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

function offsets(lat, lon, d) {
  const dLat = d / 111320, dLon = d / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lat, lon], [lat + dLat, lon], [lat - dLat, lon], [lat, lon + dLon], [lat, lon - dLon]];
}

// 日本国内: 国土地理院の標高（5m〜10mメッシュ）
async function gsiSlope(lat, lon) {
  const d = 15;
  const pts = offsets(lat, lon, d);
  const els = await Promise.all(pts.map(async ([la, lo]) => {
    const res = await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lo}&lat=${la}&outtype=JSON`);
    const v = (await res.json()).elevation;
    if (typeof v !== 'number') throw new Error('国土地理院の標高データの範囲外です');
    return v;
  }));
  return { deg: slopeFrom(...els, d), elevation: els[0], source: '国土地理院の標高データ' };
}

// 世界中: Copernicus DEM（90mメッシュ、Open-Meteo 経由）
async function globalSlope(lat, lon) {
  const d = 60;
  const pts = offsets(lat, lon, d);
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${pts.map((p) => p[0]).join(',')}&longitude=${pts.map((p) => p[1]).join(',')}`);
  const els = (await res.json()).elevation;
  if (!Array.isArray(els) || els.length !== 5) throw new Error('標高データを取得できませんでした');
  return { deg: slopeFrom(...els, d), elevation: els[0], source: 'Copernicus DEM（標高データ）' };
}

/** 撮影地点の斜度を返す。取得できなければ null */
export async function slopeAt(lat, lon) {
  try {
    return await gsiSlope(lat, lon);
  } catch {
    try {
      return await globalSlope(lat, lon);
    } catch {
      return null;
    }
  }
}

export const MANUAL_SLOPES = {
  gentle: { deg: 10, label: '緩斜面（約10°）' },
  medium: { deg: 20, label: '中斜面（約20°）' },
  steep: { deg: 30, label: '急斜面（約30°）' },
};

/**
 * 解析前に選んだ方法で斜度を決める。
 * @returns {Promise<{deg:number, source:string, auto:boolean} | null>}
 */
export async function resolveSlope(file, choice) {
  if (choice && MANUAL_SLOPES[choice]) {
    return { deg: MANUAL_SLOPES[choice].deg, source: `手入力：${MANUAL_SLOPES[choice].label}`, auto: false };
  }
  const loc = await readLocation(file);
  if (!loc) return null;
  const s = await slopeAt(loc.lat, loc.lon);
  return s ? { deg: Math.round(s.deg * 10) / 10, source: s.source, auto: true, elevation: s.elevation } : null;
}
