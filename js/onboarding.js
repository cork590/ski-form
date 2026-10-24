// アプリを開いたときに表示する、使い方の案内（スワイプで切り替えるカード）
const SLIDES = [
  { img: 'img/onboarding/1.jpg', title: 'スキーフォーム解析へようこそ', text: 'お手本の滑りとあなたの滑りを比べて、どこを直せば近づけるかをお伝えします。' },
  { img: 'img/onboarding/2.jpg', title: '骨格で比べてアドバイス', text: '動画から体の骨格を読み取り、お手本との違いを、ずれの大きい順にアドバイスします。' },
  { img: 'img/onboarding/3.jpg', title: '同じターンの大きさ・似た構図で撮る', text: 'お手本とあなたは、同じくらいのターンの大きさで、同じような位置・角度から撮ると、正確に比べられます。' },
  { img: 'img/onboarding/4.jpg', title: '撮影のコツ', text: '人物が大きく映るようにズームし、全身を入れて、カメラを水平に構えます。2ターン以上を続けて撮りましょう。' },
  { img: 'img/onboarding/5.jpg', title: 'おすすめのスマホと準備', text: '光学ズームや4K・60fpsで撮れるスマホがおすすめです。初回はAIの読み込み（約43MB）があるのでWi-Fiで。' },
  { img: 'img/onboarding/6.jpg', title: '使い方', text: '① 動画を選ぶ → ② 比べたい区間を選ぶ → ③ 解析する人を選ぶ → ④ 結果とアドバイス' },
];
const HIDE_KEY = 'onboardingHidden';

export function initOnboarding() {
  const $ = (id) => document.getElementById(id);
  const dlg = $('onboarding');
  let index = 0;

  const render = () => {
    const s = SLIDES[index];
    $('onb-img').src = s.img;
    $('onb-img').alt = s.title;
    $('onb-title').textContent = s.title;
    $('onb-text').textContent = s.text;
    $('onb-dots').innerHTML = SLIDES.map((_, i) => `<span class="${i === index ? 'active' : ''}"></span>`).join('');
    $('onb-prev').disabled = index === 0;
    $('onb-next').textContent = index === SLIDES.length - 1 ? 'はじめる' : '次へ →';
  };
  let resetZoom = () => {};
  const go = (d) => {
    index = Math.min(SLIDES.length - 1, Math.max(0, index + d));
    render();
    resetZoom(); // カードを切り替えたら等倍に戻す
  };
  const close = () => {
    try {
      if ($('onb-hide').checked) localStorage.setItem(HIDE_KEY, '1');
      else localStorage.removeItem(HIDE_KEY);
    } catch {}
    dlg.close();
  };
  const open = () => {
    index = 0;
    resetZoom();
    let hidden = false;
    try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch {}
    $('onb-hide').checked = hidden;
    render();
    dlg.showModal();
  };

  $('onb-prev').onclick = () => go(-1);
  $('onb-next').onclick = () => (index === SLIDES.length - 1 ? close() : go(1));
  $('onb-close').onclick = close;
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  $('open-onboarding').onclick = (e) => { e.preventDefault(); open(); };

  // 拡大・縮小：ピンチ（2本指）、ダブルタップ、＋／−ボタン。拡大中は1本指で移動、等倍のときは左右スワイプで切り替え
  const box = $('onb-zoom'), img = $('onb-img');
  let scale = 1, tx = 0, ty = 0;
  const MAX = 4;
  const clampPan = () => {
    const w = box.clientWidth, h = box.clientHeight;
    tx = Math.min(0, Math.max(w - w * scale, tx));
    ty = Math.min(0, Math.max(h - h * scale, ty));
  };
  const apply = () => {
    clampPan();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    $('onb-zoom-out').disabled = scale <= 1;
    $('onb-zoom-in').disabled = scale >= MAX;
  };
  // (cx, cy) を中心に倍率を変える（箱の中の座標）
  const zoomAt = (next, cx, cy) => {
    next = Math.min(MAX, Math.max(1, next));
    tx = cx - ((cx - tx) * next) / scale;
    ty = cy - ((cy - ty) * next) / scale;
    scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };
  resetZoom = () => { scale = 1; tx = 0; ty = 0; apply(); };
  $('onb-zoom-in').onclick = () => zoomAt(scale * 1.5, box.clientWidth / 2, box.clientHeight / 2);
  $('onb-zoom-out').onclick = () => zoomAt(scale / 1.5, box.clientWidth / 2, box.clientHeight / 2);

  const pts = new Map();
  let pinch = null, pan = null, swipeX = null, lastTap = 0;
  const local = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  box.addEventListener('pointerdown', (e) => {
    try { box.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: scale };
      pan = null;
      swipeX = null;
    } else if (pts.size === 1) {
      const [x, y] = local(e);
      // ダブルタップ：等倍なら2.5倍に、拡大中なら元に戻す
      const now = performance.now();
      if (now - lastTap < 300) {
        if (scale > 1) resetZoom(); else zoomAt(2.5, x, y);
        lastTap = 0;
        return;
      }
      lastTap = now;
      if (scale > 1) pan = { x, y, tx, ty }; else swipeX = e.clientX;
    }
  });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((pinch.s * d) / (pinch.d || 1), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (pan) {
      const [x, y] = local(e);
      tx = pan.tx + (x - pan.x);
      ty = pan.ty + (y - pan.y);
      apply();
    }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      pan = null;
      if (swipeX != null && scale === 1) {
        const dx = e.clientX - swipeX;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }
      swipeX = null;
    }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  apply();

  // 画像を先に読み込んでおく
  for (const s of SLIDES) { const im = new Image(); im.src = s.img; }

  let hidden = false;
  try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch {}
  if (!hidden) open();
}
