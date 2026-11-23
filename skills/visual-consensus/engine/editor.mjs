import { escapeHtml as esc } from 'review-kit/parts';
import { MAX_TEXT, normalizeImageName } from 'review-kit/model';

/** 読む画面では無名のキャプションを隠し、編集できる場所では命名ボタンにする。 */
export function imageCaption(name, editable = false) {
  if (editable) return '<button type="button" class="image-name" data-rename-image' + imageTip(name) + '>'
    + esc(name || '名前を付ける') + '</button>';
  return '<span class="image-name"' + (name ? imageTip(name) : ' hidden') + '>' + esc(name) + '</span>';
}

/** キー確定と blur が続いても一度だけ保存し、編集元のボタンまたは本文へカーソルを戻す。 */
export function editImageName(button, original, save, restoreFocus = () => button.focus({preventScroll:true})) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'image-name-input';
  input.setAttribute('aria-label', '画像の名前');
  input.value = original;

  function finish(commit) {
    input.onblur = null;
    input.replaceWith(button);
    const name = commit ? normalizeImageName(input.value) : original;
    if (name !== original) save(name);
    restoreFocus();
  }

  // 本文の貼り付け・書式・IME処理へ渡すと、名前が本文に挿入されたり親の編集が閉じたりする。
  for (const type of ['input','keyup','paste','drop','compositionstart','compositionend']) {
    input.addEventListener(type, event => event.stopPropagation());
  }
  let composing = false;
  input.oncompositionstart = () => { composing = true; };
  input.oncompositionend = () => { composing = false; };
  input.onkeydown = event => {
    event.stopPropagation();
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (!['Enter','Tab','Escape'].includes(event.key)) return;
    event.preventDefault();
    finish(event.key !== 'Escape');
  };
  input.onblur = () => finish(true);
  button.replaceWith(input);
  input.focus({preventScroll:true});
  input.select();
}

export const imageTip = name => name ? ' data-tip="' + esc(name) + '"' : '';

function imageTag(id, media, nameOf, editable) {
  const src = media(id), name = nameOf(id);
  const image = src ? '<img class="inline-image" data-inline="' + id + '" src="' + esc(src)
    + '" alt="' + esc(name || '追加した画像') + '" draggable="false"' + imageTip(name) + '>' : '画像を読み込めません';
  return '<span class="inline-figure" data-image-ref="' + id + '"' + (editable ? ' contenteditable="false"' : '')
    + '>' + image + imageCaption(name, editable) + '</span>';
}

function inline(text, media, nameOf, editable) {
  return text.split(/(\*\*[^*\n]+?\*\*|!\[U-\d+\])/g).map(part => {
    if (/^\*\*.+\*\*$/.test(part)) return '<strong>' + inline(part.slice(2,-2), media, nameOf, editable) + '</strong>';
    const image = /^!\[(U-\d+)\]$/.exec(part);
    return image ? imageTag(image[1], media, nameOf, editable) : esc(part);
  }).join('');
}

/** 本文の4種類の表記だけをHTMLにする。ブラウザやクリップボード由来のHTMLは回答に入れない。 */
export function richHtml(value, media, nameOf = () => '', editable = false) {
  const groups = [];
  let list = [];
  function finishList() {
    if (list.length) groups.push('<ul>' + list.map(x => '<li>' + (inline(x, media, nameOf, editable) || '<br>') + '</li>').join('') + '</ul>');
    list = [];
  }
  for (const line of value.split('\n')) {
    if (line.startsWith('- ')) list.push(line.slice(2));
    else { finishList(); groups.push('<div>' + (inline(line, media, nameOf, editable) || '<br>') + '</div>'); }
  }
  finishList();
  return groups.join('');
}

const block = node => ['DIV','P','LI','UL','OL'].includes(node?.nodeName);
const separator = (prev, node) => prev && (block(prev) || block(node));

function childrenText(parent) {
  if (parent.childNodes.length === 1 && parent.firstChild.nodeName === 'BR') return '';
  let result = '', prev;
  for (const node of parent.childNodes) {
    if (separator(prev, node)) result += '\n';
    result += nodeText(node);
    prev = node;
  }
  return result;
}
function nodeText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data.replaceAll('\u00a0',' ');
  if (node.nodeName === 'BR') return '\n';
  const image = node.dataset?.imageRef ?? node.dataset?.inline;
  if (image && /^U-\d+$/.test(image)) return '![' + image + ']';
  const content = childrenText(node);
  if (node.nodeName === 'LI') return '- ' + content;
  if (content && (['B','STRONG'].includes(node.nodeName) || node.style?.fontWeight === 'bold')) return '**' + content + '**';
  return content;
}

// 太字タグの分割やDIV/Pの違いに依存しない。改行・画像もそれぞれ一文字として選択範囲に数える。
function cursorMap(root) {
  const nodes = new Map(), positions = [];
  let index = 0;
  function remember(node, offset) {
    if (!nodes.has(node)) nodes.set(node, []);
    nodes.get(node)[offset] = index;
    if (!positions[index] || node.nodeType === Node.TEXT_NODE) positions[index] = [node,offset];
  }
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (let offset = 0; offset <= node.length; offset++) {
        if (offset) index++;
        remember(node, offset);
      }
      return;
    }
    let previous;
    remember(node,0);
    for (const [i, child] of Array.from(node.childNodes).entries()) {
      if (separator(previous, child)) index++;
      // 名前の長さや入力欄の有無によらず、画像全体を一つのカーソル位置として進める。
      if (child.dataset?.imageRef || child.nodeName === 'IMG') index++;
      else if (child.nodeName === 'BR') { if (node.childNodes.length > 1) index++; }
      else walk(child);
      remember(node,i+1);
      previous = child;
    }
  }
  walk(root);
  return {nodes, positions};
}

/** 表示中の選択範囲を返す。クリックで開くときは、以前の選択が残っていても押した文字の位置を返す。 */
export function readCursor(root, click) {
  if (click?.detail) {
    const {clientX, clientY} = click;
    const point = document.caretPositionFromPoint?.(clientX, clientY);
    const range = point ? null : document.caretRangeFromPoint?.(clientX, clientY);
    const node = point?.offsetNode ?? range?.startContainer;
    if (node && root.contains(node)) {
      const offset = cursorMap(root).nodes.get(node)?.[point?.offset ?? range.startOffset];
      if (offset != null) return [offset, offset];
    }
  }
  const s = getSelection();
  if (!s.rangeCount || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null;
  const {nodes} = cursorMap(root);
  const anchor = nodes.get(s.anchorNode)?.[s.anchorOffset], focus = nodes.get(s.focusNode)?.[s.focusOffset];
  return anchor == null || focus == null ? null : [anchor, focus];
}
export function putCursor(root, cursor) {
  const {positions} = cursorMap(root);
  const at = n => positions[Math.min(positions.length-1, Math.max(0,n))] ?? [root,0];
  const [anchor, focus] = cursor ?? [positions.length-1, positions.length-1];
  root.focus({preventScroll:true});
  getSelection().setBaseAndExtent(...at(anchor), ...at(focus));
}

/** host 内に一つの編集欄を置く。options.attach は画像を登録し、挿入順の仮番号または確定番号を返す。
 * 戻り値の attach(files) は、欄の外で受け取った画像も同じカーソル位置に挿入する。Esc の動作は呼び出し元が決める。
 */
export function mountEditor(host, options) {
  const {key, label, media, nameOf, rename, notify} = options;
  host.innerHTML = '<div class="editor"><div class="tool" role="toolbar" aria-label="書式">'
    + '<button type="button" data-format="bold" aria-label="太字" data-tip="太字（Ctrl+B）"><b>B</b></button>'
    + '<button type="button" data-format="insertUnorderedList">箇条書き</button>'
    + '<button type="button" data-file>画像</button><input type="file" accept="image/*" multiple hidden>'
    + (options.closeLabel ? '<button type="button" class="tool-close" data-escape aria-label="' + esc(options.closeLabel) + '" data-tip="' + esc(options.closeLabel) + '"></button>' : '') + '</div>'
    + '<div class="txt" role="textbox" aria-multiline="true" contenteditable="true" spellcheck="false"></div>'
    + (options.inline || options.externalAction ? '' : '<div class="ft">' + (options.cancel ? '<button type="button" class="text-button" data-cancel-edit>キャンセル</button>' : '') + '<button type="button" class="go" data-commit>'
      + esc(options.action ?? '確定') + '</button></div>') + '</div>';
  const txt = host.querySelector('.txt'), picker = host.querySelector('input');
  if (options.inline) {
    // 本文の先頭を閲覧時と同じ位置に保ち、書式は本文の直後で操作できるようにする。
    txt.after(host.querySelector('.tool'));
  }
  txt.dataset.rich = key;
  txt.setAttribute('aria-label',label);
  txt.dataset.placeholder = options.placeholder ?? label;
  let value = options.value ?? '', lastRange = options.cursor, pending = 0, queue = Promise.resolve();
  let composing = false;
  function display() {
    txt.innerHTML = value ? richHtml(value, media, nameOf, true) : '';
    txt.classList.toggle('blank', !value);
  }
  display();

  function capture() {
    const range = readCursor(txt);
    if (range) {
      lastRange = range; options.selection?.(range);
      for (const button of host.querySelectorAll('[data-format]')) {
        button.setAttribute('aria-pressed',String(document.queryCommandState(button.dataset.format)));
      }
    }
  }
  function change() {
    const next = childrenText(txt);
    if (next.length > MAX_TEXT) {
      if (composing) return;
      display(); putCursor(txt,lastRange);
      notify('本文は' + MAX_TEXT + '文字までです。');
      return;
    }
    value = next;
    txt.classList.toggle('blank', !value);
    options.change(value);
    capture();
  }
  function format(command) {
    if (!txt.contains(getSelection().anchorNode)) putCursor(txt,lastRange);
    document.execCommand(command);
    change();
  }
  function startList() {
    const selection = getSelection();
    const node = selection.anchorNode;
    if (!selection.isCollapsed || node?.nodeType !== Node.TEXT_NODE || node.parentElement.closest('li')) return false;
    const container = node.parentElement.closest('div,p');
    const prefix = selection.getRangeAt(0).cloneRange();
    prefix.setStart(container,0);
    if (prefix.toString() !== '-') return false;
    // 空の行でネイティブのリスト化を呼ぶと、直前の段落まで項目になることがある。
    // 行内の残りの文字を移し、カーソルを新しい項目の先頭に置く。
    const list = document.createElement('ul'), item = document.createElement('li');
    list.append(item);
    prefix.deleteContents();
    if (container === txt) {
      let child = txt.firstChild;
      while (child && !block(child)) {
        const next = child.nextSibling; item.append(child); child = next;
      }
      txt.prepend(list);
    } else {
      item.append(...container.childNodes);
      container.replaceWith(list);
    }
    if (!item.textContent && !item.querySelector('img')) item.replaceChildren(document.createElement('br'));
    selection.collapse(item,0);
    change();
    return true;
  }
  txt.onclick = event => {
    const button = event.target.closest('[data-rename-image]');
    if (!button) return;
    const unit = button.closest('[data-image-ref]'), id = unit.dataset.imageRef;
    editImageName(button, nameOf(id), name => rename(id, name), () => {
      if (!unit.isConnected) return;
      txt.focus({preventScroll:true});
      getSelection().collapse(unit.parentNode, [...unit.parentNode.childNodes].indexOf(unit) + 1);
      capture();
    });
  };
  txt.oninput = change;
  txt.onkeyup = txt.onpointerup = capture;
  txt.oncompositionstart = () => { composing = true; };
  txt.oncompositionend = () => { composing = false; change(); };
  function commit() {
    if (pending) { notify('画像を読み込み中です'); return; }
    options.commit();
  }
  txt.onkeydown = e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); options.escape(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); format('bold'); }
    else if (e.key === ' ' && startList()) e.preventDefault();
  };
  for (const btn of host.querySelectorAll('[data-format]')) {
    btn.onmousedown = e => e.preventDefault();
    btn.onclick = () => format(btn.dataset.format);
  }
  function attach(files) {
    const selected = Array.from(files);
    if (!selected.length) return;
    const origin = readCursor(txt) ?? lastRange;
    pending++;
    options.busy?.(true);
    const alive = () => txt.isConnected && host.contains(txt);
    queue = queue.then(async () => {
      if (!alive()) return;
      const ids = await options.attach(selected, alive);
      if (!alive() || !ids.length) return;
      putCursor(txt, origin);
      document.execCommand('insertHTML',false,ids.map(id => imageTag(id, media, nameOf, true)).join(''));
      change();
    }).catch(error => { if (alive()) notify(error.message); }).finally(() => {
      // 取消後に完了したデコードは、次に開いたフォームのボタンを操作しない。
      if (!--pending && alive()) options.busy?.(false);
    });
  }
  const pick = () => { capture(); picker.click(); };
  host.querySelector('[data-file]').onclick = pick;
  const closer = host.querySelector('[data-escape]');
  if (closer) closer.onclick = () => options.escape();
  picker.onchange = () => { attach(picker.files); picker.value = ''; };
  txt.onpaste = e => {
    e.preventDefault();
    const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'));
    if (files.length) attach(files);
    else document.execCommand('insertText',false,e.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));
  };
  txt.ondragover = e => { e.preventDefault(); };
  txt.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const caret = document.caretRangeFromPoint(e.clientX,e.clientY);
    if (caret && txt.contains(caret.startContainer)) { const s=getSelection(); s.removeAllRanges(); s.addRange(caret); }
    if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
    else document.execCommand('insertText',false,e.dataTransfer.getData('text/plain'));
  };
  const cancel = host.querySelector('[data-cancel-edit]');
  if (cancel) cancel.onclick = options.cancel;
  const done = host.querySelector('[data-commit]');
  if (done) done.onclick = commit;
  function setValue(next) {
    value = next;
    display();
    change();
  }
  return {txt, pick, attach, capture, commit, setValue, focus: cursor => putCursor(txt,cursor ?? lastRange), isBusy: () => pending > 0, settled: () => queue};
}
