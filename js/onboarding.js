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
  const go = (d) => {
    index = Math.min(SLIDES.length - 1, Math.max(0, index + d));
    render();
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

  // 横にスワイプして切り替える
  let startX = null;
  $('onb-img').addEventListener('pointerdown', (e) => { startX = e.clientX; });
  $('onb-img').addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  });

  // 画像を先に読み込んでおく
  for (const s of SLIDES) { const im = new Image(); im.src = s.img; }

  let hidden = false;
  try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch {}
  if (!hidden) open();
}
