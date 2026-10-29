export function html(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Lichess speed categories, from estimated game duration = initial + 40 * increment.
export function speedOf(minutes, increment) {
  const seconds = minutes * 60 + 40 * increment;
  if (seconds < 180) return 'Bullet';
  if (seconds < 480) return 'Blitz';
  if (seconds < 1500) return 'Rapid';
  return 'Classical';
}

let flashTimer;
export function flash(message) {
  const el = document.getElementById('flash');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 6000);
}
