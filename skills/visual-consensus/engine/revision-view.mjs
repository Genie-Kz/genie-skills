import { escapeHtml as esc } from 'review-kit/parts';

export const SETTLED = '@settled';

export function threadSlot(kind, id, mark = '') {
  return `<div class="reply-thread" data-thread-kind="${kind}" data-thread-id="${esc(id)}" data-thread-mark="${esc(mark)}"></div>`;
}

/** コメント本体・返事・操作を同じ単位で折り畳む。判断の選択肢はこの外側に置く。 */
export function reviewItem(kind, id, content, mark = '') {
  return `<div class="review-item" data-review-kind="${kind}" data-review-id="${esc(id)}" data-review-mark="${esc(mark)}">${content}</div>`;
}

/** 元のコメントとその操作を同じ行に置き、返事には下の行の幅を使う。 */
export function reviewComment(kind, id, comment, mark = '') {
  return reviewItem(kind, id, `<div class="review-comment">${comment}</div>${threadSlot(kind, id, mark)}`, mark);
}

export function noteSlot(kind, id, emptyLabel = '') {
  const note = `<div class="note-slot" data-field="${kind}:${esc(id)}" data-empty-label="${esc(emptyLabel)}"></div>`;
  // S 番号は題名下のセクションへの返事に使う。旧形式のコメントは独立した宛先を持つ。
  const target = kind === 'sections' && /^S-\d+$/.test(id) ? 'sectionNotes' : kind;
  return reviewComment(target, id, note);
}

/** 追記欄を入力中に周りが更新されても、同じ会話の DOM と選択範囲を保つ。 */
export function renderThread(host, model, answers) {
  const {threadKind, threadId, threadMark} = host.dataset;
  const image = model.addresses.key(threadKind, threadId);
  const key = threadMark ? image + '　' + threadMark : image;
  host.dataset.replyKey = key;
  const records = model.threads(answers, key);
  const layout = JSON.stringify([key, records.map(item => [item.edition, item.reply])]);
  if (host._threadLayout === layout) return;
  host._threadLayout = layout;
  host.innerHTML = records.map(({edition, reply}) => `<div class="agent-reply" data-reply-edition="${edition}"><span class="reply-label">第${edition}回で返事</span><p>${esc(reply)}</p></div>
    <div class="note-slot follow-up" data-field="followup:${edition}:${esc(key)}" data-empty-label="続けてコメント"></div>`).join('');
}

/** 直近の返事、返事がなければ元の記入の先頭行を要約にする。
 * 同じ項目を再描画しても開閉状態と入力中の要素を保持する。 */
export function presentReview(host, key, model, answers, canArchive, original = '') {
  host.hidden = Boolean(answers.archived?.[key]);
  if (host.hidden) return;
  const label = model.resolvedLabel(key);
  if (label && !host._fold) {
    const fold = document.createElement('details'), summary = document.createElement('summary');
    fold.className = 'resolved-item';
    const status = document.createElement('span'), excerpt = document.createElement('span');
    status.className = 'resolved-status';
    status.textContent = label;
    excerpt.className = 'resolved-excerpt';
    // セクションの種別も同じ行に置き、開いた返事にはメタ情報の行全体の幅を使う。
    const sectionKind = host.querySelector(':scope > .section-kind');
    if (sectionKind) summary.append(sectionKind);
    summary.append(status, excerpt);
    fold.append(summary, ...host.childNodes);
    if (model.hasCurrentActivity?.(answers, key)) fold.open = true;
    host.append(fold);
    host._fold = fold;
  }
  if (host._fold) {
    const reply = model.threads(answers, key).at(-1)?.reply;
    const firstLine = (reply?.trim() || original.trim() || model.filedTitle(answers, key)).split(/\r\n?|\n/, 1)[0];
    const excerpt = host._fold.querySelector('.resolved-excerpt');
    if (excerpt.textContent !== firstLine) excerpt.textContent = firstLine;
  }
  if (canArchive && !host._fileButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button file-item';
    button.textContent = '完了';
    button.dataset.archive = key;
    if (host.dataset.reviewKind === 'sectionNotes') {
      button.dataset.tip = 'このコメントを完了にする';
      button.setAttribute('aria-label', button.dataset.tip);
    }
    const content = host._fold ?? host;
    const actions = content.querySelector('.review-comment, [data-review-actions]');
    actions.insertBefore(button, actions.querySelector(':scope > [data-delete-request]'));
    host._fileButton = button;
  }
  if (host._fileButton) host._fileButton.hidden = !canArchive;
}

/** この回に書かれた返事だけを、対応状況にかかわらず冒頭の一覧に並べる。 */
export function showEditionReplies(host, doc, model, answers) {
  if (!host) return;
  const items = new Map();
  for (const [rawKey, edition] of Object.entries(doc.replyEditions ?? {})) {
    if (edition !== doc.built.number) continue;
    const {key, label} = model.replyLocation(answers, rawKey);
    const reply = model.threads(answers, key).find(item => item.edition === edition)?.reply;
    if (reply) items.set(key, {label, reply});
  }
  host.hidden = !items.size;
  if (!items.size) return;
  const rows = [...items].map(([key, {label, reply}]) => {
    const text = reply.trim(), firstLine = text.split(/\r\n?|\n/, 1)[0];
    const head = Array.from(firstLine).slice(0, 80).join('');
    const excerpt = head === text ? head : head + '…';
    return `<li><button type="button" class="reply-jump" data-see-reply="${esc(key)}" aria-label="${esc(label)}の返事へ移動" data-tip="該当箇所へ移動"><svg class="icon" aria-hidden="true"><use href="#vc-icon-reply"/></svg></button>
      <span class="reply-summary"><span class="reply-origin">${esc(label)}</span> <span class="reply-sep" aria-hidden="true">→</span> <span class="reply-excerpt">${esc(excerpt)}</span></span></li>`;
  });
  const html = `<h2>この回の返事（${items.size}件）</h2><ul>${rows.join('')}</ul>`;
  if (host._contents !== html) { host.innerHTML = html; host._contents = html; }
}

/** 畳んだ一覧には実際に選んだ値を出す。確定後も同じ ID のコメント欄を使う。 */
export function settledContents(doc) {
  const groups = [], count = doc.decisions.filter(d => d.settled || doc.sections.find(s => s.id === d.section).settled).length;
  for (const s of doc.sections) {
    const decisions = doc.decisions.filter(d => d.section === s.id && (d.settled || s.settled));
    if (!s.settled && !decisions.length) continue;
    const rows = decisions.map(d => `<li id="decision-${d.id}"><details class="settled-decision"><summary class="settled-line">
      <span class="settled-question"><small>${esc(d.id)}</small>${esc(d.question)}</span><strong data-settled-answer="${d.id}"></strong><span class="settled-cue">補足</span></summary>
      ${noteSlot('decisions', d.id, '補足を書く')}${(d.items ?? []).map(item => noteSlot('itemComments', d.id + '　' + item.id)).join('')}</details></li>`);
    const notes = s.settled ? `<details class="settled-section-notes"><summary>セクションへの補足・依頼</summary>${noteSlot('sections', s.id, 'セクションに補足を書く')}<div data-archived-notes="${s.id}"></div></details>` : '';
    groups.push(`<section class="settled-group" data-settled-section="${s.id}"><h2>${esc(s.title)}</h2>
      ${rows.length ? '<ul>' + rows.join('') + '</ul>' : ''}${notes}</section>`);
  }
  return `<header class="head"><h1>決定事項</h1></header>
    ${groups.length ? `<details class="settled-list" open><summary>${groups.length}セクション・判断${count}件</summary>${groups.join('')}</details>` : ''}
    <section class="filed-list" hidden><h2>完了したもの</h2><ul></ul></section>`;
}
