import { escapeHtml as esc } from 'review-kit/parts';
import { draftImage, inlineRefs, MAX_TEXT, removeUserSection, WHOLE } from 'review-kit/model';
import { imageCaption, imageTip, putCursor, readCursor, richHtml } from 'review-kit/editor';
import { imageAsPng } from 'review-kit/storage';

const $ = (selector, root = document) => root.querySelector(selector);
// 採番前のセクションを開くための画面上の宛先。回答のセクションや依頼の対象には使わない。
export const DRAFT_PAGE = '@draft';
const empty = target => ({target, text:'', attachments:[], images:{}});

/** 編集中の依頼と追加セクションの下書きは端末に置き、確定時に画像と本文を一緒に回答へ移す。 */
export function createForms(ctx) {
  const {store, model, view, current, notify, changed, navigate, openRich, endRich} = ctx;
  let sectionEditor;
  const media = (draft,id) => draftImage(draft, id)?.dataUrl ?? store.media[id];
  const nameOf = (draft, id) => draftImage(draft, id)?.name ?? draft?.renames?.[id] ?? ctx.nameOf(id);

  function imageNameAt(element, id) {
    const section = element.closest('.user-sheet [data-section-field="body"] .editor')?.closest('[data-section]')?.dataset.section;
    if (section) return nameOf(view().sectionDrafts?.[section === DRAFT_PAGE ? 'new' : section], id);
    const request = element.closest('.request-text,[data-request-editor]')?.closest('[data-request]')?.dataset.request;
    return nameOf(view().requestDrafts?.[request], id);
  }

  function rename(draft, id, name) {
    const image = draftImage(draft, id);
    if (image) draft.images[id] = {...image, name};
    else if (name !== ctx.nameOf(id)) (draft.renames ??= {})[id] = name;
    else if (draft.renames) delete draft.renames[id];
    saveView();
    ctx.refreshImageNames(id);
  }
  const saveView = () => store.viewEdited();

  function targetOptions(draft) {
    // 上から「このセクション・全体」「ほかのセクション」「新しいセクションを追加」の3群。群の間は <hr> で区切る
    const all = ctx.sections().filter(s => s.id !== 'general');
    const option = ([id,name]) => '<option value="' + esc(id) + '"' + (id === draft.target ? ' selected' : '') + '>' + esc(name) + '</option>';
    const near = all.filter(s => s.id === current()).map(s => [s.id,'このセクション']).concat([[WHOLE,'全体']]);
    const others = all.filter(s => s.id !== current()).map(s => [s.id,s.title]);
    if (draft.target && draft.target !== WHOLE && !all.some(s => s.id === draft.target)) {
      const title = model.sectionTitle(draft.target, store.answers);
      others.push([draft.target, title === WHOLE ? '以前の対象（' + draft.target + '）' : title + '（決定事項）']);
    }
    return near.map(option).join('') + (others.length ? '<hr>' + others.map(option).join('') : '') + '<hr>' + option(['@new','新しいセクションを追加…']);
  }

  function buttons(draft) {
    return '<div class="request-edit-actions"><label class="to"><span>対象</span><select aria-label="依頼の対象"><button><selectedcontent></selectedcontent></button>' + targetOptions(draft)
      + '</select></label><button type="button" class="attach-link" data-attach>画像を添付</button>'
      + '<button type="button" data-cancel-edit>キャンセル</button><button type="button" class="go" data-submit>確定</button></div>';
  }

  function library(draft) {
    const ids = Object.keys(store.answers.attachments).filter(id => !draft.images[id]);
    if (!ids.length) return '';
    return '<details class="library"><summary>追加済みの画像から選ぶ</summary><div>' + ids.map(id => {
      const name = nameOf(draft, id), checked = draft.attachments.includes(id) || inlineRefs(draft.text).includes(id);
      return '<label data-image-ref="' + id + '"><input type="checkbox" value="' + id + '"' + (checked ? ' checked' : '')
        + '><span class="library-image"><img src="' + media(draft, id) + '" alt="' + esc(name || '追加した画像') + '"'
        + imageTip(name) + '>' + imageCaption(name) + '</span></label>';
    }).join('') + '</div></details>';
  }

  async function stage(draft, files, alive) {
    const decoded = await Promise.all(files.map(async file => {
      try { return await imageAsPng(file); } catch { throw Error(file.name + ' を画像として読み込めませんでした'); }
    }));
    if (!alive()) return [];
    const aliases = Object.keys(draft.images).map(id => Number(id.slice(2)));
    let last = Math.max(store.answers.lastAttachmentNumber,0,...aliases);
    const ids = decoded.map(data => {
      const id = 'U-' + String(++last).padStart(2,'0');
      draft.images[id] = {dataUrl: data, name: ''};
      return id;
    });
    saveView();
    return ids;
  }

  function editField(host,key,draft,options) {
    return openRich(host,{
      key, value:draft.text, media:id => media(draft,id), placeholder:options.label,
      nameOf:id => nameOf(draft,id), rename:(id,name) => rename(draft,id,name),
      attach:(files,alive) => stage(draft,files,alive),
      change:value => {
        draft.text=value; saveView();
        const btn=host.parentElement.querySelector('[data-submit]');
        if (btn) btn.disabled=!value.trim();
      },
      busy:pending=>{
        const button=host.parentElement.querySelector('[data-submit]');
        if (button) button.disabled=pending || !draft.text.trim();
      },
      ...options,
    });
  }

  function bindRequest(host, draft, api) {
    const select = $('.to select',host), button = $('[data-submit]',host);
    button.disabled = !draft.text.trim();
    const hint = () => { select.dataset.tip = select.selectedOptions[0]?.text ?? ''; };
    hint();
    select.onchange = () => {
      if (select.value === '@new') { select.value=draft.target; newSection('request',draft.id); return; }
      draft.target=select.value; saveView(); hint();
    };
    $('[data-attach]',host).onclick = () => api.pick();
    button.onclick = () => api.commit();
    host.querySelectorAll('.library input').forEach(input => {
      input.onchange = () => {
        const id=input.value;
        if (input.checked) draft.attachments=[...new Set([...draft.attachments,id])];
        else {
          draft.attachments=draft.attachments.filter(x=>x!==id);
          draft.text=draft.text.replaceAll('!['+id+']','');
          api.setValue(draft.text);
        }
        saveView();
      };
    });
  }

  function editRequest(entry, record, focus = true, cursor) {
    const drafts = view().requestDrafts ??= {};
    const draft = drafts[record.id] ??= {...empty(record.target), ...record,
      attachments: record.attachments.filter(id=>!inlineRefs(record.text).includes(id))};
    view().requestId=record.id;
    const key='request:' + record.id;
    const host=$('[data-request-editor]',entry);
    entry.classList.add('editing');
    host.innerHTML='<div class="form-body"></div>' + library(draft) + buttons(draft);
    function close(discard) {
      endRich(key);
      if (discard) delete drafts[record.id];
      entry.classList.remove('editing'); host.replaceChildren(); saveView();
      if (focus) $('[data-edit-request]',entry)?.focus({preventScroll:true});
    }
    function submit() {
      try { model.submitDraft(store.answers, store.media, 'request', draft); }
      catch (error) { notify(error.message); return; }
      close(true); changed(); notify('依頼を更新しました');
    }
    const api=editField($('.form-body',host),key,draft,{label:'依頼の本文',focus,cursor,commit:submit,
      externalAction:true,escape:()=>{ close(false); ctx.previewRequest(record.id); }});
    bindRequest(host, draft, api);
    $('[data-cancel-edit]',host).onclick=()=>{ close(true); ctx.previewRequest(record.id); };
    saveView();
  }

  function newSection(origin, requestId) {
    if (sectionBusy() && current() !== DRAFT_PAGE) { notify('画像を読み込み中です'); return; }
    const drafts = view().sectionDrafts ??= {};
    const draft = drafts.new ??= {...empty(''), title: '', focus: 'title', inline: true};
    // 一覧から書きかけを開き直しても、作成を始めた依頼と戻り先を覚えておく。
    if (!draft.returnTo || origin !== 'nav') {
      if (current() !== DRAFT_PAGE) draft.returnTo = current();
      draft.origin = origin;
      draft.requestId = requestId;
      draft.originCursor = view().cursor?.slice();
    }
    saveView();
    navigate(DRAFT_PAGE);
  }

  // 旧版のダイアログは背後のセクションを URL に残していた。明示的に別のセクションを開いたときも下書きは保持する。
  function migrateSectionForm() {
    const workspace = view(), draft = workspace.sectionForm;
    if (!draft) return;
    const pageId = draft.id ?? DRAFT_PAGE;
    draft.returnTo = workspace.section ?? ctx.sections()[0].id;
    draft.requestId = workspace.requestId;
    draft.focus = workspace.editor === 'section-form' && !workspace.titleFocus ? 'body' : 'title';
    draft.cursor = workspace.editor === 'section-form' ? workspace.cursor : null;
    draft.titleCursor = workspace.titleCursor;
    (workspace.sectionDrafts ??= {})[draft.id ?? 'new'] = draft;
    if (!location.hash || location.hash.slice(1) === draft.returnTo) {
      workspace.section = pageId;
      workspace.editor = 'section-form';
      history.replaceState(null, '', '#' + pageId);
    }
    delete workspace.sectionForm;
    delete workspace.titleFocus;
    delete workspace.titleCursor;
    saveView();
  }

  const draftKey = id => id === DRAFT_PAGE ? 'new' : id;
  const sectionDraft = id => view().sectionDrafts?.[draftKey(id)];
  const recordFor = id => store.answers.userSections.find(s => s.id === id);
  const fieldOf = (page, field) => page.querySelector('[data-section-field="' + field + '"]');

  function sectionBusy() { return sectionEditor?.api?.isBusy() ?? false; }

  // 移動・再読み込みでは下書きと選択範囲を残す。確定や Esc のときだけ呼び出し側で下書きを片付ける。
  function unmountSection() {
    if (!sectionEditor) return;
    const {host, field} = sectionEditor;
    sectionEditor = null;
    if (field === 'title') {
      host.removeAttribute('contenteditable');
      host.oninput = host.onpaste = host.oncompositionend = null;
      host.onkeyup = host.onpointerup = null;
    }
    endRich(field === 'body' ? 'section-form' : 'section-title');
    host.replaceChildren();
    host.removeAttribute('aria-required');
    host.removeAttribute('aria-invalid');
  }

  function paintField(host, field, draft, record, editing) {
    const label = field === 'title' ? '題名' : 'セクションの本文';
    if (field === 'title') host.textContent = draft?.title ?? record?.title ?? '';
    else {
      const value = draft?.text ?? record?.body;
      host.innerHTML = value ? richHtml(value, id => media(draft, id), id => nameOf(draft, id)) : '';
    }
    if (editing) {
      host.tabIndex = 0;
      host.setAttribute('role', 'button');
      host.setAttribute('aria-label', field === 'title' && host.textContent ? host.textContent + '、題名を書き換える' : label + 'を書き換える');
    } else {
      for (const attr of ['role', 'tabindex', 'aria-label']) host.removeAttribute(attr);
    }
  }

  function renderSection(page) {
    if (!page?.classList.contains('user-sheet') || sectionEditor?.page === page) return;
    const id = page.dataset.section, draft = sectionDraft(id), record = recordFor(id);
    const editing = Boolean(draft || view().sectionModes?.[id]);
    page.classList.toggle('editing', editing);
    for (const input of page.querySelectorAll('[data-section-mode]')) input.checked = input.dataset.sectionMode === (editing ? 'edit' : 'view');
    for (const field of ['title', 'body']) {
      const host = fieldOf(page, field);
      paintField(host, field, draft, record, editing);
      host.onkeydown = editing ? event => {
        if (event.target === host && ['Enter', ' '].includes(event.key) && !event.isComposing) {
          event.preventDefault();
          beginField(page, field);
        }
      } : null;
    }
    const add = $('[data-publish-section]', page);
    if (add) add.disabled = !draft?.title.trim();
    if (page.hidden || !editing) return;
    if (draft?.focus) beginField(page, draft.focus, draft.focus === 'title' ? draft.titleCursor : draft.cursor);
    else if (view().sectionResume?.[id]) {
      const {field, cursor} = view().sectionResume[id];
      delete view().sectionResume[id];
      beginField(page, field, cursor);
    }
  }

  function beginField(page, field, cursor) {
    if (sectionEditor) return;
    ctx.leaveRich();
    const id = page.dataset.section, key = draftKey(id), record = recordFor(id);
    const drafts = view().sectionDrafts ??= {};
    const draft = drafts[key] ??= {...empty(''), id, title: record.title, text: record.body, inline: true};
    (view().sectionModes ??= {})[id] = true;
    const host = fieldOf(page, field);
    // 新しいセクションでは題名と本文の間を行き来できる。Esc で戻すのは今回開いた欄とその仮画像だけ。
    if (!draft.before) {
      draft.before = {
        value: field === 'title' ? record?.title ?? '' : record?.body ?? '',
        names: {}, renames: {},
      };
      if (!record && !draft.focus) {
        draft.before.value = field === 'title' ? draft.title : draft.text;
        draft.before.names = Object.fromEntries(Object.keys(draft.images).map(id => [id, nameOf(draft, id)]));
        draft.before.renames = {...draft.renames};
      }
    }
    draft.focus = field;
    const editor = sectionEditor = {page, host, field, draft};
    host.onkeydown = null;
    host.removeAttribute('tabindex');
    host.removeAttribute('role');
    host.removeAttribute('aria-label');
    if (field === 'body') {
      editor.api = openRich(host, {
        key: 'section-form', label: 'セクションの本文', value: draft.text, cursor, inline: true,
        media: id => media(draft, id), nameOf: id => nameOf(draft, id), rename: (id, name) => rename(draft, id, name),
        attach: (files, alive) => stage(draft, files, alive),
        change(value) { draft.text = value; saveView(); },
        selection(range) { draft.cursor = range; },
        commit: () => commitField(true), escape: cancelField, leave: () => endRich('section-form'),
        busy(pending) { const add = $('[data-publish-section]', page); if (add) add.disabled = pending || !draft.title.trim(); },
      });
    } else {
      host.contentEditable = 'plaintext-only';
      host.setAttribute('role', 'textbox');
      host.setAttribute('aria-label', '題名');
      host.setAttribute('aria-required', 'true');
      host.textContent = draft.title;
      view().editor = 'section-title';
      function selection() {
        const range = readCursor(host);
        if (range) { draft.titleCursor = range; saveView(); }
      }
      host.onkeyup = host.onpointerup = selection;
      host.oninput = host.oncompositionend = event => {
        if (event.isComposing) return;
        const value = host.innerText.replace(/[\r\n]+/g, ' ');
        if (value.length > MAX_TEXT) {
          host.textContent = draft.title;
          putCursor(host, draft.titleCursor);
          notify('題名は' + MAX_TEXT + '文字までです');
          return;
        }
        draft.title = value;
        if (!value) host.replaceChildren();
        host.removeAttribute('aria-invalid');
        if (!record) {
          ctx.updateDraftTitle(value);
          $('[data-publish-section]', page).disabled = !value.trim();
        }
        selection();
        saveView();
      };
      host.onpaste = event => {
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' '));
      };
      host.onkeydown = event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); cancelField(); }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitField(true); }
        else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
          event.preventDefault();
          if (record ? commitField(false) : stageField()) beginField(page, 'body');
        }
      };
      putCursor(host, cursor);
    }
    saveView();
  }

  document.addEventListener('selectionchange', () => {
    if (sectionEditor?.field === 'title' && document.activeElement === sectionEditor.host) {
      const range = readCursor(sectionEditor.host);
      if (range) { sectionEditor.draft.titleCursor = range; saveView(); }
    }
  });

  function stageField() {
    if (sectionBusy()) return false;
    const {page, draft} = sectionEditor;
    delete draft.before;
    draft.focus = null;
    unmountSection();
    renderSection(page);
    saveView();
    return true;
  }

  function cancelField() {
    if (!sectionEditor) return;
    const {page, draft, field} = sectionEditor;
    const id = page.dataset.section, record = recordFor(id);
    const original = draft.before;
    if (field === 'title') draft.title = original.value;
    else {
      draft.text = original.value;
      for (const key of Object.keys(draft.images)) {
        if (!Object.hasOwn(original.names, key)) delete draft.images[key];
        else draft.images[key] = {...draftImage(draft, key), name: original.names[key]};
      }
      draft.renames = original.renames;
    }
    delete draft.before;
    draft.focus = null;
    unmountSection();
    if (record && draft.title === record.title && draft.text === record.body
        && !Object.keys(draft.images).length && !Object.keys(draft.renames ?? {}).length) delete view().sectionDrafts[id];
    if (!record) {
      if (!draft.title && !draft.text) { discardNew(); return; }
      ctx.updateDraftTitle(draft.title);
    }
    renderSection(page);
    fieldOf(page, field).focus({preventScroll:true});
    saveView();
  }

  function returnToRequest(draft) {
    if (draft.origin === 'request') ctx.resumeRequest(draft.originCursor, draft.requestId);
  }

  function discardNew() {
    const draft = sectionDraft(DRAFT_PAGE);
    if (!draft) return;
    unmountSection();
    delete view().sectionDrafts.new;
    if (view().sectionModes) delete view().sectionModes[DRAFT_PAGE];
    navigate(draft.returnTo ?? ctx.sections()[0].id, null, true);
    returnToRequest(draft);
    if (draft.origin === 'nav') ($('.nav').clientWidth ? $('[data-new-section]') : $('#sections')).focus({preventScroll:true});
    saveView();
  }

  function publish(page, draft, nextMode = 'edit') {
    const pageId = page.dataset.section, record = recordFor(pageId);
    if (!draft.title.trim()) {
      if (sectionEditor?.field === 'body') stageField();
      if (!sectionEditor) beginField(page, 'title');
      fieldOf(page, 'title').setAttribute('aria-invalid', 'true');
      fieldOf(page, 'title').focus();
      notify('題名を入力してください');
      return false;
    }
    // 別の欄からセクションの末尾に追加された画像や、フォルダから読み直した未編集の欄を引き継ぐ。
    const data = {...draft};
    if (record) {
      data.attachments = record.attachments.filter(id => !inlineRefs(record.body).includes(id));
      if (draft.inline && draft.focus === 'title') Object.assign(data, {text: record.body, images: {}, renames: {}});
      if (draft.inline && draft.focus === 'body') data.title = record.title;
    }
    let id;
    try { id = model.submitDraft(store.answers, store.media, 'section', data); }
    catch (error) { notify(error.message); return false; }
    if (sectionEditor?.page === page) unmountSection();
    delete view().sectionDrafts[draftKey(pageId)];
    const modes = view().sectionModes ??= {};
    delete modes[pageId];
    if (nextMode === 'edit') modes[id] = true;
    if (!record && draft.origin === 'request' && view().requestDrafts?.[draft.requestId]) view().requestDrafts[draft.requestId].target = id;
    changed();
    if (!record && current() === pageId) {
      navigate(draft.origin === 'request' ? draft.returnTo : id, null, true);
      returnToRequest(draft);
      notify('新しいセクションを追加しました');
    }
    saveView();
    return true;
  }

  function commitField(refocus, nextMode = 'edit') {
    if (!sectionEditor) return true;
    if (sectionBusy()) { notify('画像を読み込み中です'); return false; }
    const {page, draft, field} = sectionEditor;
    if (!publish(page, draft, nextMode)) return false;
    if (refocus && page.isConnected) fieldOf(page, field).focus({preventScroll:true});
    return true;
  }

  // 公開済みのセクションは画面を離れる前に回答へ反映する。新規ページは追加ボタンを押すまで下書き。
  function finishSectionEdit(rememberField = false) {
    if (!sectionEditor || sectionEditor.page.dataset.section === DRAFT_PAGE) return true;
    const {page, field, draft} = sectionEditor;
    const cursor = field === 'title' ? draft.titleCursor : draft.cursor;
    if (!commitField(false)) return false;
    // 履歴で戻る人には同じ欄と選択範囲を返す。本文・画像はすでに回答にあるので二重に下書きへ入れない。
    if (rememberField) (view().sectionResume ??= {})[page.dataset.section] = {field, cursor};
    return true;
  }

  function publishNew() {
    if (!sectionBusy()) publish($('.user-sheet:not([hidden])'), sectionDraft(DRAFT_PAGE));
  }

  function setSectionMode(page, mode) {
    const id = page.dataset.section, edit = mode === 'edit';
    if (page.classList.contains('editing') === edit) return;
    if (!edit && (sectionEditor || sectionDraft(id))) {
      const saved = sectionEditor ? commitField(false, mode) : publish(page, sectionDraft(id), mode);
      if (!saved) $('[data-section-mode="edit"]', page).checked = true;
      return;
    }
    const modes = view().sectionModes ??= {};
    if (edit) modes[id] = true;
    else delete modes[id];
    renderSection(page);
    saveView();
  }

  async function deleteSection(trigger) {
    const id = current(), record = recordFor(id), dialog = $('#delete-section-dialog');
    if (!record || dialog.open) return;
    $('#delete-section-title').textContent = '「' + record.title + '」を削除しますか？';
    dialog.returnValue = 'cancel';
    dialog.showModal();
    await new Promise(resolve => dialog.addEventListener('close', resolve, {once: true}));
    // 確認中に別の回答を読み込んだ場合、同じ番号の別セクションに削除を適用しない。
    if (dialog.returnValue !== 'delete' || current() !== id || recordFor(id) !== record) {
      if (trigger.isConnected && current() === id) trigger.focus({preventScroll: true});
      return;
    }
    unmountSection();
    removeUserSection(store.answers, id);
    if (view().sectionDrafts) delete view().sectionDrafts[id];
    if (view().sectionModes) delete view().sectionModes[id];
    for (const draft of Object.values(view().requestDrafts ?? {})) {
      if (draft?.target === id) draft.target = WHOLE;
    }
    changed();
    navigate('general', null, true);
    $('#main').focus({preventScroll: true});
    saveView();
    notify('セクションを削除しました');
  }

  // 書式や画像名のボタンは本文の一部。マウスでは click の宛先が決まってから確定し、
  // 描き直した見出しや一覧のせいで、利用者が押したリンクの操作を取りこぼさない。
  let pointerTarget;
  document.addEventListener('pointerdown', event => { pointerTarget = event.target; }, true);
  document.addEventListener('pointercancel', () => { pointerTarget = null; }, true);
  document.addEventListener('keydown', () => { pointerTarget = null; }, true);
  function finishOutside(event) {
    const editor = sectionEditor, target = event.target;
    if (!editor || editor.host.contains(target) || target.closest?.('dialog, a[download], #switch-edition, #save-status, .section-modes, [data-cancel-section], [data-publish-section], [data-delete-section], [data-archive], [data-restore]')) return true;
    if (sectionBusy()) {
      if (event.type === 'click') { event.preventDefault(); event.stopImmediatePropagation(); notify('画像を読み込み中です'); }
      return false;
    }
    if (editor.page.dataset.section === DRAFT_PAGE && editor.page.contains(target.closest?.('[data-section-field]'))) return stageField();
    return commitField(false);
  }
  document.addEventListener('click', event => {
    pointerTarget = null;
    // 題名・本文は編集モードでだけボタンになる。内側の画像やリンクが押されたら、その操作に任せる。
    const control = event.target.closest('.inline-figure, a, button, input, select, textarea, label, summary, [role="button"], [role="link"]');
    const page = control?.matches('[data-section-field][role="button"]') && control.closest('.user-sheet.editing');

    // 前の欄を確定すると本文が描き直されるため、先に元の文字上の位置を読む。
    const cursor = page ? readCursor(control, event) : null;
    if (!finishOutside(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (page && !event.defaultPrevented) {
      beginField(page, control.dataset.sectionField, cursor);
    }
  }, true);
  document.addEventListener('focusin', event => { if (!pointerTarget) finishOutside(event); });

  return {sectionSettled: () => sectionEditor?.api?.settled(), imageNameAt, editRequest, newSection, renderSection, unmountSection, sectionBusy,
    migrateSectionForm, finishSectionEdit, setSectionMode, discardNew, publishNew, deleteSection,
    attachToSection(files) {
      if (sectionEditor?.field === 'title') stageField();
      if (!sectionEditor) beginField($('.user-sheet:not([hidden])'), 'body');
      sectionEditor.api.attach(files);
    }};
}
