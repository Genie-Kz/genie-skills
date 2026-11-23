import { escapeHtml as esc } from 'review-kit/parts';
import { decisionOptions } from 'review-kit/model';

const reference = /(?<![A-Za-z0-9_])D[0-9]+(?![A-Za-z0-9_])/g;
const prose = '[data-manuscript], .head h1, .head .lead, .decision-intro .context, .decision-intro .q, .item-note';
const excluded = 'a, code, pre, kbd, samp, button, input, textarea, select, label, script, style, svg, math, [contenteditable], .q > i';

/** 原稿のテキストノードだけを分割する。既存のリンク・コード・操作要素の中身とイベントは保持する。 */
export function linkDecisionNumbers(page, decisions) {
  if (!decisions.size) return;
  for (const region of page.querySelectorAll(prose)) {
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.data.includes('D') && !node.parentElement.closest(excluded)) nodes.push(node);
    }
    for (const node of nodes) {
      let start = 0;
      const content = document.createDocumentFragment();
      for (const match of node.data.matchAll(reference)) {
        const id = match[0];
        if (!decisions.has(id)) continue;
        const link = document.createElement('a');
        link.href = '#decision-' + id;
        link.className = 'decision-reference';
        link.dataset.decisionRef = id;
        link.setAttribute('aria-haspopup', 'dialog');
        link.setAttribute('aria-expanded', 'false');
        link.textContent = id;
        content.append(node.data.slice(start, match.index), link);
        start = match.index + id.length;
      }
      if (start) {
        content.append(node.data.slice(start));
        node.replaceWith(content);
      }
    }
  }
}

/** リンクの直後をプレビューのTab順にする。画面内に収まる側に出し、長い説明は窓の中だけでスクロールする。 */
export function decisionPreviews(decisions, currentAnswer) {
  let source, timer;
  const popup = document.createElement('span');
  popup.className = 'decision-preview';
  popup.id = 'decision-preview';
  popup.setAttribute('popover', 'manual');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-labelledby', 'preview-question');

  function close() {
    clearTimeout(timer);
    if (!source) return;
    source.removeAttribute('aria-controls');
    source.setAttribute('aria-expanded', 'false');
    source = null;
    popup.remove();
  }

  function position() {
    if (!source) return;
    const rect = source.getBoundingClientRect();
    if (!rect.height || rect.bottom < 0 || rect.top > innerHeight) { close(); return; }
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    popup.style.removeProperty('--preview-space');
    const useAbove = below < popup.offsetHeight && above > below;
    popup.style.setProperty('--preview-space', (useAbove ? above : below) + 'px');
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8)) + 'px';
    popup.style.top = (useAbove ? rect.top - popup.offsetHeight - 4 : rect.bottom + 4) + 'px';
  }

  function show(link) {
    clearTimeout(timer);
    if (link === source) return;
    close();
    source = link;
    const d = decisions.get(link.dataset.decisionRef);
    const rec = d.items ? d.items.map(item => item.label + '：' + item.recommended).join('、')
      : [].concat(d.recommended).join('、');
    const options = decisionOptions(d).map(option => '<li>' + esc(option.label) +
      (option.note ? '<span>' + esc(option.note) + '</span>' : '') + '</li>').join('');
    const items = (d.items ?? []).filter(item => item.note).map(item => '<li>' + esc(item.label) + '：' + esc(item.note) + '</li>').join('');
    popup.innerHTML = '<button type="button" class="icon-btn preview-expand" data-jump="' + esc(d.id) + '" title="問いへ移動" aria-label="問いへ移動">'
      + '<svg class="icon" aria-hidden="true"><use href="#vc-icon-expand"/></svg></button>'
      + '<span class="preview-heading" id="preview-question"><span><i>' + esc(d.id) + '</i>' + esc(d.question) + '</span></span>'
      + '<span class="preview-recommended">推奨：' + esc(rec) + '</span>'
      + '<span class="preview-current">今の答え：<b>' + esc(currentAnswer(d)) + '</b></span>'
      + (d.context ? '<span class="preview-context">' + esc(d.context) + '</span>' : '')
      + (items ? '<ul>' + items + '</ul>' : '')
      + '<span class="preview-options">選択肢</span><ul>' + options + '</ul>';
    source.after(popup);
    source.setAttribute('aria-controls', popup.id);
    source.setAttribute('aria-expanded', 'true');
    popup.showPopover?.();
    popup.scrollTop = 0;
    position();
  }

  const linkAt = target => target?.closest?.('[data-decision-ref]');
  const inside = target => target && (source?.contains(target) || popup.contains(target));
  function leave(event) {
    if (!source || !inside(event.target) || inside(event.relatedTarget)) return;
    clearTimeout(timer);
    // 番号と窓の間の小さな余白をマウスで横切れるようにする。
    timer = setTimeout(() => {
      const keepFocus = event.type === 'pointerout' ? popup.contains(document.activeElement) : inside(document.activeElement);
      if (!popup.matches(':hover') && !source?.matches(':hover') && !keepFocus) close();
    }, 180);
  }
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const link = linkAt(event.target);
    if (link) show(link);
    else if (inside(event.target)) clearTimeout(timer);
  });
  document.addEventListener('pointerout', leave);
  document.addEventListener('focusin', event => {
    const link = linkAt(event.target);
    if (link) show(link);
    else if (inside(event.target)) clearTimeout(timer);
    else close();
  });
  document.addEventListener('focusout', leave);
  document.addEventListener('keydown', event => {
    if (source && event.key === 'Escape') {
      event.preventDefault();
      if (popup.contains(document.activeElement)) source.focus({preventScroll: true});
      close();
    }
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', event => { if (source && !popup.contains(event.target)) position(); }, true);
  return {close};
}
