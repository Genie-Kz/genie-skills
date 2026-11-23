import { escapeHtml as esc, photoFrame } from 'review-kit/parts';
import { atChoiceLimit, compactDecision, decisionOptions, DEFER, MAX_TEXT, OTHER } from 'review-kit/model';

import { noteSlot } from 'review-kit/revision-view';

function otherField(id) {
  return `<div class="decision-other" data-other-field hidden>
    <textarea rows="1" data-other-text="${id}" aria-label="その他の内容" placeholder="その他の内容" maxlength="${MAX_TEXT}" aria-describedby="other-hint-${id}"></textarea>
    <small id="other-hint-${id}">内容を入力すると回答になります。</small></div>`;
}

function optionGroup(d, item) {
  const fit = item || compactDecision(d);
  const recommended = item ? [item.recommended] : d.multiple ? d.recommended : [d.recommended];
  const groupName = item ? `decision:${d.id}:${item.id}` : 'decision:' + d.id;
  const labelledBy = item ? `question-${d.id} item-${groupName}` : 'question-' + d.id;
  const options = decisionOptions(d).map(({label, note}) => {
    const rec = recommended.includes(label);
    const itemAttr = item ? ` data-item-id="${item.id}"` : '';
    const editor = !item && d.other !== false && label === OTHER ? otherField(d.id) : '';
    return `<div class="decision-option${rec ? ' is-rec' : ''}${label === DEFER ? ' defer' : ''}">
      <label class="decision-pick"><input type="${d.multiple ? 'checkbox' : 'radio'}" name="${groupName}" data-choice="${d.id}"${itemAttr} value="${esc(label)}">
      <span class="choice-indicator" aria-hidden="true"></span><span class="choice-copy"><span class="choice-name">${esc(label)}</span>${rec ? '<small class="choice-rec">推奨</small>' : ''}${note ? '<span class="choice-note">' + esc(note) + '</span>' : ''}</span></label>${editor}</div>`;
  });
  return `<div class="decision-options" style="--choice-columns: ${options.length}" data-layout="${fit ? 'segments' : 'list'}"${fit && !item?.figure ? ' data-fit' : ''} role="${d.multiple ? 'group' : 'radiogroup'}" aria-labelledby="${labelledBy}"${d.multiple ? ' aria-describedby="choice-hint-' + d.id + '"' : ''}>${options.join('')}</div>`;
}

function itemControls(d) {
  const blocks = [], rows = [];

  // 連続する画像なしの項目は一つの表に収め、元の列幅と行見出しを保つ。
  function flushRows() {
    if (!rows.length) return;
    blocks.push(`<table class="decision-matrix" aria-labelledby="question-${d.id}"><tbody>${rows.join('')}</tbody></table>`);
    rows.length = 0;
  }

  for (const [index, item] of d.items.entries()) {
    const titleId = `item-decision:${d.id}:${item.id}`;
    const label = esc(item.label);
    const note = item.note ? `<span class="item-note">${esc(item.note)}</span>` : '';
    const choices = optionGroup(d, item);
    if (!item.figure) {
      rows.push(`<tr><th scope="row" id="${titleId}">${label}${note ? ' ' + note : ''}</th><td>${choices}${noteSlot('itemComments', d.id + '　' + item.id)}</td></tr>`);
      continue;
    }

    flushRows();
    blocks.push(`<div class="decision-card">
      <h4 id="${titleId}">${index + 1}. ${label}</h4>${note}
      <button type="button" class="item-photo" id="photo-${titleId}" data-photo="${esc(item.figure)}" aria-label="${label}の画像を拡大">
        ${photoFrame(item.figure, item.note || item.label)}<span class="item-zoom" aria-hidden="true">拡大</span>
      </button><div class="item-actions">${choices}<button type="button" class="text-button" data-write="itemComments:${d.id}　${item.id}">コメント</button></div>
      ${noteSlot('itemComments', d.id + '　' + item.id)}</div>`);
  }
  flushRows();
  return blocks.join('');
}

/** 同じ入力要素を一覧と横並びで使う。表示幅が変わっても選択値と入力位置を保てる。 */
export function decisionControls(d) {
  let controls;
  if (d.items) {
    controls = itemControls(d);
  } else {
    const hint = d.multiple ? `<p class="choice-hint" id="choice-hint-${d.id}" aria-live="polite"></p>` : '';
    controls = hint + optionGroup(d);
  }
  return `<div class="decision-controls" data-controls="${d.id}">${controls}</div>`;
}

// field-sizing が使えないブラウザでは、表示中の欄を1行の高さに戻して折り返し後の本文を測る。
function fitOtherText(textarea) {
  if (CSS.supports('field-sizing', 'content') || !textarea?.clientWidth) return;
  const scrollTop = textarea.scrollTop;
  textarea.style.height = 'auto';
  if (textarea.scrollHeight > textarea.clientHeight) {
    const borders = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = (textarea.scrollHeight + borders) + 'px';
  }
  textarea.scrollTop = scrollTop;
}

/** IME とカーソル位置を保ったまま回答を反映する。チェックを書き換えた場合は太字の幅を測り直すため true を返す。 */
export function showDecisionAnswer(host, d, answer) {
  const choice = answer?.choice;
  let checkedChanged = false;
  for (const input of host.querySelectorAll('[data-choice]')) {
    const value = input.value;
    const checked = d.items ? choice?.[input.dataset.itemId] === value
      : d.multiple ? (choice ?? []).includes(value) : choice === value;
    if (input.checked !== checked) {
      input.checked = checked;
      checkedChanged = true;
    }
    const disabled = Boolean(atChoiceLimit(d, choice, value));
    if (input.disabled !== disabled) input.disabled = disabled;
  }
  if (d.multiple) {
    const limit = d.max && choice?.length >= d.max;
    const message = limit ? `上限の${d.max}件を選びました。ほかを選ぶには1件外してください。`
      : d.max ? `${d.max}件まで選べます。` : '当てはまるものをすべて選んでください。';
    const hint = host.querySelector('.choice-hint');
    if (hint.textContent !== message) hint.textContent = message;
  }
  const field = host.querySelector('[data-other-field]');
  if (field) {
    const textarea = field.querySelector('textarea');
    field.hidden = !(d.multiple ? choice?.includes(OTHER) : choice === OTHER);
    if (textarea.value !== (answer?.otherText ?? '')) textarea.value = answer?.otherText ?? '';
    field.querySelector('small').hidden = answer?.otherText === undefined || Boolean(textarea.value.trim());
    fitOtherText(textarea);
  }
  return checkedChanged;
}

// 札・「その他」・「保留」も含む自然幅を実際のフォントで測る。非表示のセクションは表示時に測る。
export function fitDecisionControls(host) {
  const groups = Array.from(host.querySelectorAll('[data-fit]'));
  if (!groups.length) {
    fitOtherText(host.querySelector('[data-other-text]'));
    return;
  }
  const available = host.clientWidth;
  if (!available) return;
  const tables = host.querySelectorAll('.decision-matrix');
  for (const table of tables) table.classList.toggle('stack-items', available <= 600);
  // 先に横並びにそろえてから幅をまとめて読む。表の行ごとにレイアウトを計算させない。
  for (const group of groups) {
    if (group.dataset.layout !== 'segments') group.dataset.layout = 'segments';
  }
  const tooWide = groups.filter(group => group.getBoundingClientRect().width > available);
  for (const group of tooWide) group.dataset.layout = 'list';
  for (const table of tables) {
    if (table.getBoundingClientRect().width > available) table.classList.add('stack-items');
  }
  fitOtherText(host.querySelector('[data-other-text]'));
}

/** セクションの切り替え・ズーム・ウィンドウの幅の変更で、入る区画だけを横並びにする。 */
export function observeDecisionWidths(root) {
  const hosts = root.querySelectorAll('[data-controls]');
  if (!hosts.length) return;
  const widths = new WeakMap();
  const observer = new ResizeObserver(entries => {
    for (const {target, contentRect} of entries) {
      if (widths.get(target) === contentRect.width) continue;
      widths.set(target, contentRect.width);
      fitDecisionControls(target);
    }
  });
  for (const host of hosts) observer.observe(host);
  document.fonts.ready.then(() => hosts.forEach(fitDecisionControls));
}

