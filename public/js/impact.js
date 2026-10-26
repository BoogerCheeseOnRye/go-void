/* GO/VOID — DOM impact frames: full-screen type, rays and inverted flashes. */

const VARIANTS = {
  capture: { kanji: '取', word: 'CAPTURE', color: '#ff3f9f', duration: 460 },
  atari: { kanji: '詰', word: 'ATARI', color: '#ffb15e', duration: 340 },
  start: { kanji: '開', word: 'BEGIN', color: '#6af6ff', duration: 520 },
  win: { kanji: '勝', word: 'VICTORY', color: '#ffd07a', duration: 900 },
  lose: { kanji: '敗', word: 'DEFEAT', color: '#ff3f9f', duration: 900 },
  resign: { kanji: '投', word: 'RESIGN', color: '#ff3f9f', duration: 620 },
  match: { kanji: '縁', word: 'MATCHED', color: '#6af6ff', duration: 700 },
  score: { kanji: '算', word: 'SCORE', color: '#6af6ff', duration: 520 },
};

let fireToken = 0;

export function fireImpact(type = 'capture', { reduced = false } = {}) {
  if (reduced) return;
  const layer = document.getElementById('impact-layer');
  if (!layer) return;
  const variant = VARIANTS[type] || VARIANTS.capture;
  const kanji = layer.querySelector('.impact-kanji');
  const word = layer.querySelector('.impact-word');
  if (kanji) kanji.textContent = variant.kanji;
  if (word) word.textContent = variant.word;
  layer.style.setProperty('--impact-color', variant.color);
  layer.style.setProperty('--impact-duration', `${variant.duration}ms`);
  layer.classList.remove('fire');
  // Force a style flush so the animation restarts even on rapid captures.
  void layer.offsetWidth;
  layer.classList.add('fire');
  const token = ++fireToken;
  window.setTimeout(() => {
    if (token === fireToken) layer.classList.remove('fire');
  }, variant.duration + 40);
}

export function clearImpact() {
  fireToken++;
  document.getElementById('impact-layer')?.classList.remove('fire');
}
