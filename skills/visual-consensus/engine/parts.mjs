/** 原稿中の文字を HTML の本文または引用符で囲んだ属性に入れる。 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/** id は版をまたいで同じ行を指す。title は回答に添える文脈。html は執筆者の本文。 */
export const block = (id, title, html) => ({id, title, html});

/** 印の位置を割合で重ねるため、画像と同じ寸法になる枠を返す。 */
export function photoFrame(key, caption) {
  const id = escapeHtml(key);
  return `<span class="rv-frame" data-thumb="${id}"><img data-asset="${id}" alt="${escapeHtml(caption)}"></span>`;
}

export function fig(key, caption, size = '') {
  const id = escapeHtml(key), description = escapeHtml(caption);
  return `<figure class="evidence ${escapeHtml(size)}">
    <button type="button" class="photo" data-photo="${id}" aria-label="画像を拡大（${id}）">
      ${photoFrame(key, caption)}
    </button>
    <figcaption><span class="id">${id}</span><span class="cap">${description}</span></figcaption>
  </figure>`;
}

/** ゲームなど題材固有の表現は contents と題材の CSS で用意する。 */
export function mock(id, title, contents) {
  return `<figure data-mock="${escapeHtml(id)}">
    <div class="mock-screen">
      <div class="mock-title">${escapeHtml(title)}</div>
      <div class="mock-body">${contents}</div>
    </div>
    <figcaption class="id">${escapeHtml(id)}</figcaption>
  </figure>`;
}

export const pair = (one, two) => `<div class="duo">${one}${two}</div>`;
export const col = (title, body) => `<div class="unit"><h3>${escapeHtml(title)}</h3>${body}</div>`;
export const note = (title, body) => `<div class="note"><strong>${escapeHtml(title)}</strong><p>${body}</p></div>`;
export const pathflow = (...steps) => `<ol class="flow">${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;

export function table(headers, lines) {
  const header = headers.map(h => `<th scope="col">${h}</th>`).join('');
  const body = lines.map(cells => '<tr>' + cells.map((value, i) =>
    i ? `<td>${value}</td>` : `<th scope="row">${value}</th>`).join('') + '</tr>').join('');
  return `<table class="spec"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}
