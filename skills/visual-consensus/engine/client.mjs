import { escapeHtml as esc } from 'review-kit/parts';
import { answerModel, answerDifferences, addAttachment, canFillDecision, counts, decisionSummary, draftImage, draftTextChanged, formDraftLabel,
  hasSelection, markName, portableAnswers, settledAnswer, removeAttachment, removeRequest, setDecisionChoice, setOtherText, WHOLE } from 'review-kit/model';
import { decisionControls, fitDecisionControls, observeDecisionWidths, showDecisionAnswer } from 'review-kit/decision-controls';
import { decisionPreviews, linkDecisionNumbers } from 'review-kit/decision-links';
import { createStorage, imageAsPng } from 'review-kit/storage';
import { editImageName, imageCaption, imageTip, mountEditor, richHtml } from 'review-kit/editor';
import { createForms, DRAFT_PAGE } from 'review-kit/requests';
import { drawThumbs, photoViewer } from 'review-kit/photo';
import { watchEditions } from 'review-kit/edition-watch';
import { mountTopbar } from 'review-kit/topbar';
import { noteSlot as slot, presentReview, renderThread, reviewComment, reviewItem, SETTLED, settledContents, showEditionReplies, threadSlot } from 'review-kit/revision-view';

const $ = (selector, root = document) => root.querySelector(selector);
const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const general = {id:'general',title:'全体へのコメント'};

const marks = id => `<ul class="marks" data-marks="${id}"></ul>`;
const photo = (id, label, name = '') => `<button type="button" class="photo" data-photo="${id}" aria-label="${esc(name || label)}"${imageTip(name)}><span class="rv-frame" data-thumb="${id}"><img data-asset="${id}" alt="${esc(name || label)}"></span></button>`;
const bulk = '<button type="button" data-bulk hidden></button>';

// コメントの宛先の呼び名。画面案は内部IDではなく題名で呼ぶ（題名がなければ並び順）。
// メニューは「コメント」ボタンの下に出るので、項目には宛先だけを書く（「〜へのコメント」と重ねない）。
const mockName = (r,id) => r.mockTitles?.[id] ? '「'+r.mockTitles[id]+'」' : r.mocks.length>1 ? ' '+(r.mocks.indexOf(id)+1)+'つ目' : '';
function rowComments(r) {
  const choices = [ ['rows',r.id], ...r.mocks.map(id=>['mocks',id]) ];
  if (choices.length===1) return `<div class="hover"><button type="button" data-write="rows:${r.id}">コメント</button></div>`;
  const label = (k,id) => k==='mocks' ? '画面案'+esc(mockName(r,id)) : '「'+esc(r.title)+'」全体';
  return `<div class="hover"><button type="button" data-menu aria-expanded="false">コメント</button>
    <div class="comment-menu" hidden>${choices.map(([k,id])=>`<button type="button" data-write="${k}:${id}">${label(k,id)}</button>`).join('')}</div></div>`;
}

function decisionRow(d) {
  return `<div class="row" data-decision-row="${d.id}" id="decision-${d.id}">
    <div class="c decision-intro"><h3 class="q" id="question-${d.id}"><i>${d.id}</i>${esc(d.question)}</h3>
    <div class="hover"><button type="button" data-write="decisions:${d.id}">コメント</button></div>
    ${d.context ? '<p class="context">' + esc(d.context) + '</p>' : ''}</div>
    <div class="j">${slot('decisions', d.id)}${decisionControls(d)}</div></div>`;
}

export async function start(installDemo = () => {}) {
  const {doc,assets} = JSON.parse($('#review-data').textContent);
  $('#review-data').remove();
  const decisions = new Map(doc.decisions.map(d => [d.id, d]));
  const rows = doc.sections.flatMap(section => section.rows);
  const model=answerModel(doc), main=$('#main'), sheets=$('#sheets'), selector=$('#sections');
  let store, current, active, forms, viewer, editions, ready=false, noticeTimer, statusState, resumeMarkNote;
  const view=()=>store.workspace;
  // ブラウザはフォルダ選択の初期位置に任意のパスを渡せない。代わりに、資料の隣の answers のパスをコピーできるようにする。
  const answersPath=(()=>{
    if (location.protocol!=='file:') return '';
    const dir=decodeURIComponent(location.pathname).replace(/\/[^/]*$/,'')+'/answers';
    if (/^\/[A-Za-z]:\//.test(dir)) return dir.slice(1).replaceAll('/','\\');
    return location.host ? '\\\\'+location.host+dir.replaceAll('/','\\') : dir;
  })();
  const media=id=>store.media[id] ?? assets[id];
  const nameOf=id=>store.answers.attachments[id]?.name ?? '';
  const bodyHtml=value=>richHtml(value, media, nameOf);
  const activeSections = doc.sections.filter(s => !s.settled);
  const {activeDecisions} = model;
  const previews = decisionPreviews(decisions, d => activeDecisions.includes(d)
    ? settledAnswer(d, store.answers.decisions[d.id]) : model.settledSummary(store.answers, d));
  let litQuestion, arrivalTimer;
  const archived = doc.sections.length !== activeSections.length || doc.decisions.length !== activeDecisions.length;
  const archive = {id: SETTLED, title: '決定事項'};
  const firstSection = activeSections[0] ?? archive;
  const visibleUsers = () => store.answers.userSections.filter(s => !store.answers.archived?.[s.id]);
  const visibleRequests = () => store.answers.requests.filter(r => !store.answers.archived?.[r.id] && !(/^S-\d+$/.test(r.target) && store.answers.archived?.[r.target]));
  const hasArchive = () => archived || Boolean(Object.keys(store.answers.archived ?? {}).length);
  const items = () => [...activeSections, ...visibleUsers(), general];
  const topbar = mountTopbar(doc, {answersPath, save: manualSave, choose: (change = false) => store.selectFolder(undefined, change),
    switchEdition: () => editions.accept(), notify});
  const draftPage = () => ({id: DRAFT_PAGE, title: view().sectionDrafts.new.title.trim() || '新しいセクション'});
  const pages = () => [...activeSections, ...visibleUsers(), ...(view().sectionDrafts?.new ? [draftPage()] : []),
    general, ...(hasArchive() ? [archive] : [])];
  const named = id => pages().find(s => s.id === id);
  const sheet=()=>$('.sheet:not([hidden])',sheets);
  function notify(message, duration = 2300, undo) {
    const notice = $('#notice');
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.hidden = false;
    if (undo) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '元に戻す';
      button.onclick = () => { undo(); notice.hidden = true; };
      notice.append(button);
    }
    noticeTimer = setTimeout(() => { notice.hidden = true; }, duration);
  }
  function conflict(local, disk, savedAt) {
    const dialog = $('#conflict'), details = $('#conflict-details'), sources = $('#conflict-sources');
    const diff = answerDifferences(doc, local, disk);
    $('#conflict-description').textContent = `この端末とフォルダで、回答が ${diff.total} か所違います。`;
    const visible = diff.decisions.slice(0, 3);
    details.innerHTML = visible.map(d => `<div><span>${esc(d.id)}</span>この端末${esc(d.local)}／フォルダ${esc(d.disk)}</div>`).join('');
    if (diff.total > visible.length || !diff.total) {
      const rest = document.createElement('div');
      if (!diff.total) rest.textContent = '保存履歴が異なります。';
      else if (!visible.length) rest.textContent = `判断以外の回答 ${diff.total} 件`;
      else rest.textContent = `ほか ${diff.total - visible.length} 件`;
      details.append(rest);
    }

    const labels = {local: 'この端末', disk: 'フォルダ'};
    const newer = savedAt.local > savedAt.disk ? 'local' : savedAt.disk > savedAt.local ? 'disk' : null;
    // 同じ分の保存を区別できるよう、必要な場合だけ秒またはミリ秒まで表示する。
    const precision = {hour: '2-digit', minute: '2-digit', hour12: false};
    if (newer && Math.floor(savedAt.local / 60000) === Math.floor(savedAt.disk / 60000)) {
      precision.second = '2-digit';
      if (Math.floor(savedAt.local / 1000) === Math.floor(savedAt.disk / 1000)) precision.fractionalSecondDigits = 3;
    }
    function time(stamp) {
      if (!stamp) return '保存時刻不明';
      const date = new Date(stamp);
      const day = date.toDateString() === new Date().toDateString() ? '今日' : date.toLocaleDateString('ja-JP');
      return day + ' ' + date.toLocaleTimeString('ja-JP', precision) + ' に保存';
    }
    sources.innerHTML = Object.entries({local, disk}).map(([key, pack]) => `<label class="conflict-choice">
      <input type="radio" name="conflict-source" value="${key}" ${key === (newer ?? 'local') ? 'checked' : ''}>
      <span>${labels[key]}の回答 ${key === newer ? '<b class="conflict-new">新しい</b>' : ''}
      <small>${time(savedAt[key])}・回答 ${counts(pack.answers).total} 件</small></span></label>`).join('');
    const confirm = $('#conflict-keep');
    function showChoice() {
      confirm.value = $('input:checked', sources).value;
      confirm.textContent = labels[confirm.value] + 'の回答を残す';
    }
    sources.onchange = showChoice;
    showChoice();
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => {
      // ×・Esc・中断のどれから閉じても、保存元を明示していない回答で上書きしない。
      const choice = dialog.returnValue;
      resolve(choice === 'local' || choice === 'disk' ? choice : 'cancel');
    }, {once: true}));
  }


  function issueCard(i,index) {
    const target=i.sections[0], summary=esc(i.summary);
    let preview='';
    if (i.file) {
      let image=`<img data-asset="${i.id}" alt="">`;
      if (i.preview) {
        const [x,y,w,h]=i.preview;
        image=`<span class="shot-clip" style="--crop-ratio:${w/h};--crop-left:${-100*x/w}%;--crop-top:${-100*y/h}%"><img data-asset="${i.id}" data-crop-width="${w}" alt=""></span>`;
      }
      preview='<span class="shot">'+image+'</span>';
    }
    if (index) {
      const links=i.sections.slice(1).map(id=>`<a class="other-section" href="#${id}">${esc(model.sectionTitle(id, store.answers))}</a>`).join('');
      return `<li><a class="issue index-card" href="#${target}" data-issue="${i.id}">${preview}<span><b>指摘 ${i.id}</b> ${summary}</span><span class="destination">${esc(model.sectionTitle(target, store.answers))}</span></a>${links}</li>`;
    }
    const content=preview + `<span><b>指摘 ${i.id}</b> ${summary}</span>`;
    return i.file ? `<button type="button" class="issue" data-photo="${i.id}">${content}<span class="issue-count" data-issue-marks="${i.id}" hidden></span></button>`
      : `<div class="issue">${content}</div>`;
  }
  function bodyRow(r) {
    if (r.type==='issues') return `<div class="issue-directory" data-row="${r.id}"><h2>送っていただいた指摘（${doc.issues.length}件）</h2><ul class="issue-index">${doc.issues.map(i=>issueCard(i,true)).join('')}</ul><div class="index-comment">${rowComments(r)}${slot('rows',r.id)}</div></div>`;
    let body=r.html;
    if (r.type==='decisions') {
      const rows=activeDecisions.map(d=>`<tr><th><a href="#${d.section}" data-jump="${d.id}">${d.id}</a></th><td>${esc(d.question)}</td><td>${esc(d.items ? '項目ごとに表示' : d.multiple ? d.recommended.join('、') : d.recommended)}</td><td data-current="${d.id}"></td></tr>`);
      body=`<div class="decision-index-head"><h3>判断の一覧</h3>${bulk}</div><table class="spec decision-index"><thead><tr><th>番号</th><th>問い</th><th>推奨</th><th>現在の回答</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    return `<div class="row" data-row="${r.id}"><div class="c"${r.type ? '' : ' data-manuscript'}>${body}</div><div class="j">${rowComments(r)}${r.photos.map(marks).join('')}${r.mocks.map(id=>slot('mocks',id)).join('')}${slot('rows',r.id)}</div></div>`;
  }

  function footer(id, user = false) {
    const isGeneral=id==='general';
    const approval = model.canApproveSection(id)
      ? `<button type="button" class="opt" data-approve-section="${id}" aria-pressed="false">このセクションはOK</button>` : '';
    const saved = `<div data-attachments="${id}"></div>${slot('sections', id)}<div data-section-requests="${id}"></div>`;
    if (user) return `<footer class="section-tail" data-scope="${id}">${saved}<div class="tail-bar"><button type="button" class="text-button" data-delete-section>セクションを削除</button></div></footer>`;
    return `<footer class="section-tail" data-scope="${id}">
      ${saved}
      <div class="tail-bar"><button type="button" class="section-comment text-button" data-write="sections:${id}">${isGeneral ? '全体にコメント' : 'このセクションにコメント'}</button>${approval}</div></footer>`;
  }
  // 軽い枠を原稿順に置き、本文は初めて表示する時に入れる。印刷でも同じ順序を使う。
  function sheetShell(id, user = false) {
    return `<section class="sheet${user ? ' user-sheet' : ''}" data-section="${id}" hidden></section>`;
  }

  function sectionContents(s,user=false) {
    if (s.id==='general') return `<div class="head general-heading"><h1>${general.title}</h1><div id="general-exports"></div></div>${footer('general')}<div class="request-list" data-requests="all"></div>`;
    if (user) {
      const fresh = s.id === DRAFT_PAGE;
      const modes = [['view','閲覧'], ['edit','編集']].map(([value, label]) =>
        `<label class="opt"><input type="radio" name="mode-${s.id}" data-section-mode="${value}"><span>${label}</span></label>`).join('');
      const fileSection = fresh ? '' : `<button type="button" class="text-button file-item" data-archive="${s.id}" aria-label="このセクションを完了にする" data-tip="このセクションを完了にする">完了</button>`;
      const conversation = fresh ? '' : reviewItem('sections', s.id,
        `<span class="section-kind">追加したセクション</span>${threadSlot('sections', s.id)}`);
      return `<header class="head">
        <div class="section-heading"><h1><span data-section-field="title" data-placeholder="題名"></span></h1>${fileSection}
        <div class="opts section-modes" role="radiogroup" aria-label="このセクションの表示" aria-keyshortcuts="Control+E Meta+E">${modes}</div></div>
        ${fresh ? '' : `<div class="dec section-meta">${conversation}</div>`}</header>
        <div class="user-body prose"><div data-section-field="body" data-placeholder="セクションの本文"></div></div>
        ${fresh ? '<div class="section-tail draft-actions"><button type="button" data-cancel-section>追加をやめる</button><button type="button" class="go" data-publish-section>セクションを追加</button></div>' : footer(s.id, true)}`;
    }
    const related=doc.issues.filter(i=>i.sections.includes(s.id)), ds=activeDecisions.filter(d=>d.section===s.id);
    const dec=ds.length ? '<p class="dec">このセクションで決めること '+ds.map(d=>`<a href="#${s.id}" data-jump="${d.id}">${d.id}</a>`).join('、')+'（セクションの最後）</p>' : '';
    const cards=related.map(i=>'<div>'+issueCard(i,false)+'</div>').join('');
    const index=s.rows.filter(r=>r.type==='issues').map(bodyRow).join('');
    return `<header class="head${cards?' with-issues':''}${related.length>1?' several':''}">
      <div><h1>${esc(s.title)}</h1>${s.lead?'<p class="lead">'+esc(s.lead)+'</p>':''}${dec}</div>
      ${cards?'<div class="head-issues">'+cards+'</div>':''}</header>${index}
      <div class="cols"><div class="colh">内容</div><div class="colh">回答</div></div>
      ${s.rows.filter(r=>r.type!=='issues').map(bodyRow).join('')}${ds.map(decisionRow).join('')}${footer(s.id)}`;
  }
  function restoreDisclosures(page) {
    for (const row of all('[data-row]', page)) {
      all('.c details', row).forEach((detail, index) => {
        const key = row.dataset.row + '/' + index;
        detail.open = view().disclosures?.[key] ?? detail.open;
        detail.addEventListener('toggle', () => {
          (view().disclosures ??= {})[key] = detail.open;
          store.viewEdited();
        });
      });
    }
  }

  function mountSheet(page) {
    if (page.hasChildNodes()) return;
    const id = page.dataset.section;
    page.innerHTML = id === SETTLED ? settledContents(doc) : sectionContents(named(id), page.classList.contains('user-sheet'));
    if (activeSections.some(section => section.id === id)) linkDecisionNumbers(page, decisions);
    if (id === firstSection.id) {
      page.querySelector('h1').insertAdjacentHTML('afterend', '<section class="edition-replies" aria-label="この回の返事" hidden></section>');
    }
    observeDecisionWidths(page);
    if (!doc.script) restoreDisclosures(page);
    if (id === general.id) topbar.status(statusState);
  }

  function setImages(root) {
    for (const img of all('img[data-asset]',root)) {
      const src=media(img.dataset.asset);
      if (!src || img.getAttribute('src')===src) continue;
      // 切り抜くのはカードだけ。ビューアと印は常に投稿原本の寸法を使う。
      if (img.dataset.cropWidth) img.onload=()=>{ img.style.width=(100*img.naturalWidth/Number(img.dataset.cropWidth))+'%'; };
      const itemFrame = img.closest('.item-photo .rv-frame');
      if (itemFrame) {
        img.addEventListener('load', () => {
          itemFrame.classList.toggle('portrait', img.naturalHeight > img.naturalWidth);
          itemFrame.style.setProperty('--image-ratio', img.naturalWidth / img.naturalHeight);
        }, {once: true});
      }
      img.src=src;
    }
  }
  let usersSeen, archiveSeen, hasDraftPage;
  function navigation(force=false) {
    const a=store.answers;
    if (!sheets.childElementCount) {
      sheets.innerHTML = activeSections.map(s => sheetShell(s.id)).join('') + sheetShell(general.id);
      $('#links').innerHTML = activeSections.map(s => navLink(s)).join('');
    }
    const hasDraft = Boolean(view().sectionDrafts?.new);
    if (force || usersSeen !== a.userSections || archiveSeen !== a.archived || hasDraftPage !== hasDraft) {
      usersSeen = a.userSections;
      hasDraftPage = hasDraft;
      archiveSeen = a.archived;
      const settled = sheets.querySelector(`[data-section="${SETTLED}"]`);
      if (hasArchive() && !settled) sheets.insertAdjacentHTML('beforeend', sheetShell(SETTLED));
      if (!hasArchive()) settled?.remove();
      $('#archive-link').innerHTML = hasArchive() ? `<a href="#${SETTLED}" data-nav="${SETTLED}">決定事項</a>` : '';
      const listed = visibleUsers();
      if (hasDraft) listed.push(draftPage());
      for (const el of all('.user-sheet', sheets)) if (!listed.some(s => s.id === el.dataset.section)) el.remove();
      for (const s of listed) {
        const el = $(`[data-section="${s.id}"]`, sheets);
        if (!el) sheets.insertAdjacentHTML('beforeend', sheetShell(s.id, true));
      }
      $('#user-links').innerHTML = listed.map(s=>navLink(s,true)).join('');
      $('#user-empty').hidden = listed.length > 0;
      selector.innerHTML = '<button><selectedcontent></selectedcontent></button>' + pages().map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')
        + '<option value="@new">新しいセクションを追加…</option>';
      if (current) selector.value = current;
      markCurrent();
      return true;
    }
  }
  function updateDraftTitle(value) {
    const label = value.trim() || '新しいセクション';
    const row = $(`[data-item="${DRAFT_PAGE}"]`);
    if (current === DRAFT_PAGE) $('#page-name').textContent = label;
    row.dataset.tip = label;
    $('.nav-t', row).textContent = label;
    selector.querySelector(`option[value="${DRAFT_PAGE}"]`).textContent = label;
  }
  // 判断のない作者のセクションは、一覧の丸を押して了承（OK）を付け外しする。
  // 追加したセクションは利用者が書いたセクションで、答える問いがないので丸を出さない。
  function navLink(s,user=false) {
    const mark=user ? '' : model.canApproveSection(s.id)
      ? `<button type="button" class="m-btn" data-approve-section="${s.id}" aria-pressed="false" aria-label="${esc(s.title)}をOKにする"><i class="m ok"></i></button>`
      : s.id === DRAFT_PAGE ? '' : '<i class="m" role="img"></i>';
    // 上段は分類、下段は1行のセクション名（全文はツールチップ）。利用者のセクションは分類を持たないのでセクション名だけの1行。番号（S-01）は画面に出さない。
    const group=s.group ?? '';
    return `<div class="nav-item" data-item="${s.id}" data-tip="${esc(s.title)}"><a href="#${s.id}" data-nav="${s.id}">${group ? `<small class="nav-g">${esc(group)}</small>` : ''}<span class="nav-title"><span class="nav-t">${esc(s.title)}</span></span></a>${mark}</div>`;
  }
  function markCurrent() {
    $('#page-name').textContent = named(current)?.title ?? '';
    for (const a of all('[data-nav]')) {
      const on=a.dataset.nav===current;
      a.classList.toggle('on',on);
      if (on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    }
    $('#prev-section').disabled=selector.selectedIndex<=0;
    $('#next-section').disabled=selector.selectedIndex>=pages().length-1;
  }
  function progress(sectionId) {
    const a=store.answers,p=counts(a, activeDecisions);
    topbar.progress(p.chosen, activeDecisions.length, p.total, p.deferred);
    const generalNote = a.sections.general?.trim() && !a.archived?.[model.addresses.key('sections', 'general')];
    const requests = String(visibleRequests().length + Number(Boolean(generalNote)));
    if ($('#request-count').textContent !== requests) $('#request-count').textContent = requests;
    const sections = sectionId ? items().filter(section => section.id === sectionId) : items();
    for (const section of sections) {
      const {state, label} = model.sectionProgress(a, section.id);
      const option = selector.querySelector(`option[value="${section.id}"]`);
      const hold = state === 'hold' ? '<i class="m hold" aria-hidden="true"></i>' : '';
      const title = `<span class="option-title">${esc(section.title)}</span>${hold}`;
      const content = title + (a.userSections.includes(section) ? '' : `<span class="option-status">（${esc(label)}）</span>`);
      if (option._label === content) continue;
      option.innerHTML = content;
      option._label = content;
      const icon = $(`.nav-item[data-item="${section.id}"] .m`);
      if (icon) {
        const toggle = icon.parentElement.matches('[data-approve-section]');
        icon.className = 'm ' + state + (toggle ? ' ok' : '');
        icon.setAttribute('aria-label', label);
        icon.closest('.nav-item').dataset.tipSub = label;
        if (toggle) icon.parentElement.dataset.tip = store.answers.approvedSections[section.id] === true ? 'OKを取り消す' : 'このセクションをOKにする';
        if (toggle) {
          icon.parentElement.dataset.tipSub = label;
          icon.parentElement.setAttribute('aria-pressed', String(a.approvedSections[section.id] === true));
        }
      }
    }
  }
  function select(id,jump,restoring=false,historyMove=false) {
    if (navigation()) progress();
    const oldSection = doc.sections.find(section => section.id === id && section.settled);
    const s = oldSection ? archive : named(id) ?? firstSection;
    if (!restoring && current !== s.id) {
      const busy = forms.sectionBusy();
      if (busy || !forms.finishSectionEdit(historyMove)) {
        selector.value = current;
        history.replaceState(null, '', '#' + current);
        if (busy) notify('画像を読み込み中です');
        return false;
      }
    }
    if (current!==s.id || restoring) {
      if (!restoring) leaveRich();
      forms.unmountSection();
      if (s.id === DRAFT_PAGE) view().sectionDrafts.new.returnTo ??= current ?? firstSection.id;
      previews.close();
      const previous = sheet();
      if (previous) previous.hidden = true;
      current = s.id;
      const page = $(`[data-section="${current}"]`, sheets);
      mountSheet(page);
      page.hidden = false;
      selector.value=current; markCurrent();
      if (!restoring) { main.scrollTop=0; view().scroll=0; }
      view().section=current;
      if (ready) store.viewEdited();
      refreshPage(page);
    }
    if (s.id === SETTLED && (jump || oldSection)) {
      $('.settled-list').open = true;
      const detail = jump && $(jump)?.querySelector('.settled-decision');
      if (detail) detail.open = true;
    }
    if (oldSection) jump = `[data-settled-section="${oldSection.id}"]`;
    if (jump) {
      const target = $(jump);
      for (let el = target?.parentElement; el; el = el.parentElement) if (el.matches('details')) el.open = true;
      target?.scrollIntoView({block:'center'});
    }
    return true;
  }
  function navigate(id, jump, replace = false) {
    if (!select(id, jump)) return false;
    if (location.hash !== '#' + current) {
      if (replace) history.replaceState(null, '', '#' + current);
      else location.hash = current;
    }
    return true;
  }
  function goToQuestion(id) {
    const d = decisions.get(id);
    previews.close();
    if (!navigate(activeDecisions.includes(d) ? d.section : SETTLED, '#decision-' + id)) return;
    const question = $('#question-' + id) ?? $('#decision-' + id + ' .settled-line');
    if (!question) return;
    question.tabIndex = -1;
    question.focus({preventScroll: true});
    question.scrollIntoView({block: 'center'});
    clearTimeout(arrivalTimer);
    litQuestion?.classList.remove('decision-arrival');
    litQuestion = question;
    question.classList.add('decision-arrival');
    arrivalTimer = setTimeout(() => question.classList.remove('decision-arrival'), 1000);
  }

  function revealReply(button) {
    const a = store.answers, key = button.dataset.seeReply;
    const target = model.replyLocation(a, key);
    function reveal(element) {
      if (!element) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('details')) parent.open = true;
      }
      element.tabIndex = -1;
      element.focus({preventScroll: true});
      element.scrollIntoView({block: 'center'});
      return true;
    }
    const address = CSS.escape(key);
    const replyIn = root => root.querySelector(`[data-reply-key="${address}"] [data-reply-edition="${doc.built.number}"]`);
    if (a.archived?.[key] || a.archived?.[target.page] || a.archived?.[target.owner]) {
      if (!navigate(SETTLED)) return;
      const entry = sheet().querySelector(`[data-filed-address="${address}"]`);
      const reply = entry && [...entry.querySelectorAll('.filed-reply')].find(p => p.textContent.startsWith(`返事（第${doc.built.number}回）`));
      if (reveal(reply ?? entry)) return;
    } else if (target.page) {
      if (!navigate(target.settled ? SETTLED : target.page)) return;
      if (reveal(replyIn(sheet()))) return;
      if (target.image && media(target.image)) {
        viewPhoto(target.image);
        if (reveal(replyIn($('.photo-zoom')))) return;
        $('.photo-zoom').close();
      }
    }
    // 別の端末では、追加セクション・依頼・印の元データが保存先をつなぐまで届かない。
    if (!navigate(firstSection.id)) return;
    const origin = sheet().querySelector(`[data-see-reply="${address}"]`);
    const excerpt = origin?.parentElement.querySelector('.reply-excerpt');
    if (excerpt) excerpt.textContent = model.threads(a, key).find(item => item.edition === doc.built.number).reply;
    reveal(origin);
    notify('元のコメントを表示するには、回答を保存したフォルダを選んでください。');
  }

  function route() {
    const hash=location.hash.slice(1), d=hash.startsWith('decision-') && decisions.get(hash.slice('decision-'.length));
    if (d) {
      const dest = activeDecisions.includes(d) ? d.section : SETTLED;
      history.replaceState(null, '', '#' + dest); select(dest, '#decision-' + d.id, false, true);
    }
    else if (select(hash, null, false, true) && hash && hash !== current) history.replaceState(null, '', '#' + current);
  }
  function endRich(key) {
    if (active?.spec.key===key) active=null;
    if (view().editor===key) {
      if (view().noteDraft?.key === key) delete view().noteDraft;
      delete view().editor; delete view().cursor; store.viewEdited();
    }
  }
  function leaveRich() {
    if (active) (active.spec.leave ?? active.spec.escape)();
  }
  function openRich(host,spec) {
    if (active && active.spec.key !== spec.key) leaveRich();
    const api = mountEditor(host, {nameOf, rename: renameAttachment, ...spec, notify, selection: range => {
      if (view().editor !== spec.key) return;
      view().cursor = range;
      spec.selection?.(range);
      store.viewEdited();
    }});
    // セクションの本文はほかの入力欄を開いても残る。戻った欄の選択範囲を再び保存対象にする。
    function activate(field) {
      if (active?.api === api) return;
      if (active && active.spec.key !== spec.key) leaveRich();
      active = {host, spec, api};
      view().editor = spec.key;
      view().cursor = spec.cursor ?? null;
      store.viewEdited();
      if (field && document.activeElement !== field) field.focus({preventScroll:true});
    }
    api.txt.addEventListener('focus', () => activate(api.txt));
    activate();
    if (spec.focus !== false) api.focus(spec.cursor);
    return {...api, activate};
  }
  document.addEventListener('selectionchange',()=>{ if (active?.api.txt===document.activeElement) active.api.capture(); });

  function revealInput(field) {
    const focus = document.activeElement;
    // 印の吹き出しはフォーカス後に配置される。配置後に一度だけ測り、欄を開いた人が移動済みなら追いかけない。
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      if (document.activeElement === focus && field.isConnected && entry.intersectionRatio < 1) {
        field.scrollIntoView({block: 'nearest', inline: 'nearest'});
      }
    }, {threshold: 1});
    observer.observe(field);
  }

  document.addEventListener('focusin', ({target}) => {
    if (!ready || !target.matches('[data-rich], [data-section-field][contenteditable], .image-name-input')) return;
    revealInput(target.matches('[data-rich]') ? target.closest('.editor') : target);
  });

  function followUpField(field) {
    const match = /^followup:(\d+):(.+)$/.exec(field);
    return match && {edition: Number(match[1]), key: match[2]};
  }
  function valueOf(key) {
    const follow = followUpField(key);
    if (follow) return model.threads(store.answers, follow.key).find(item => item.edition === follow.edition)?.comment ?? '';
    const [kind,id]=key.split(':'), a=store.answers;
    if (kind==='decisions' || kind==='attachments') return a[kind][id]?.comment ?? '';
    return a[kind]?.[id] ?? '';
  }
  function writeValue(key,value) {
    const [kind,id]=key.split(':'), a=store.answers;
    // 記入済みのコメントを書き足しても、回答の件数と章の進み具合は変わらない。
    const updateProgress = !valueOf(key).trim() || !value.trim();
    const follow = followUpField(key);
    if (follow) model.followUp(a, follow.key, follow.edition, value);
    else if (kind==='itemComments') model.setItemComment(a, id, value);
    else if (kind==='decisions') {
      const d=a.decisions[id] ??= {choice:null,comment:''}; d.comment=value;
      if (!d.comment.trim() && !hasSelection(d)) delete a.decisions[id];
    } else if (kind==='attachments') a.attachments[id].comment=value;
    else if (value.trim()) a[kind][id]=value; else delete a[kind][id];
    store.edited();
    if (updateProgress) progress(kind === 'sections' ? id : undefined);
  }
  function renderSlot(host,force=false) {
    if (active?.host===host) return;
    const key=host.dataset.field, [kind]=key.split(':'), value=valueOf(key);
    if (!force && host._noteValue===value) return;
    host._noteValue=value;
    const empty=host.dataset.emptyLabel;
    host.innerHTML=value ? `<button type="button" class="note" data-write="${key}"><span class="by">${esc(noteLabel(key))}</span><span class="formatted">${bodyHtml(value)}</span></button>`
      : empty ? `<button type="button" class="text-button" data-write="${key}">${esc(empty)}</button>` : '';
  }
  // 画面案へのコメントは、どの画面案かが分かるよう題名を添える。
  // 書いたコメントの見出しは宛先だけ（「「閉室から記録確定まで」」「画面案「ルームを作る」」「判断 D1」）。入力欄の案内には「へのコメント」を付ける。
  function noteLabel(key) {
    const [kind,id]=key.split(':');
    if (kind==='followup') return '返事への追記';
    if (kind==='mocks') { const r=rows.find(r=>r.mocks.includes(id)); return '画面案'+(r ? mockName(r,id) : ''); }
    if (kind==='rows') { const r=rows.find(r=>r.id===id); return r ? '「'+r.title+'」' : 'この項目'; }
    if (kind==='decisions') return '判断 '+id;
    if (kind==='itemComments') {
      const [decision, item] = id.split('　');
      return decisions.get(decision).items.find(entry => entry.id === item).label;
    }
    if (kind==='sections') return id === 'general' ? '全体' : 'このセクション';
    return '画像の説明';
  }
  const noteHint=key=>/^(photos|attachments|followup):/.test(key) ? noteLabel(key) : noteLabel(key)+'へのコメント';
  // コメントは入力ごとに回答にも保存する。欄を開いた時の本文を端末に覚え、元の内容に戻したら更新を待たない。
  function openComment(host, spec) {
    const saved = view().editor === spec.key && view().noteDraft?.key === spec.key ? view().noteDraft : null;
    const original = saved ? saved.original ?? '' : spec.value;
    return openRich(host, {...spec, value: saved?.text ?? spec.value, change(text) {
      if (draftTextChanged(text, original)) view().noteDraft = {key: spec.key, text, original};
      else delete view().noteDraft;
      store.viewEdited();
      spec.change(text);
    }});
  }
  function editNote(key,host,cursor,focus=true) {
    if (!host) return;
    const owner = current === SETTLED ? host.closest('[data-settled-section]')?.dataset.settledSection ?? 'general' : current;
    const a = store.answers;
    const close=()=>{
      endRich(key); renderSlot(host,true); refresh();
      const opener=$('[data-write]',host) ?? host.closest('.decision-card')?.querySelector('.item-actions button') ?? host.closest('.row')?.querySelector('.hover button') ?? host.closest('.section-tail')?.querySelector('.tail-bar [data-write]');
      if (focus) opener?.focus({preventScroll:true});
    };
    return openComment(host,{key,label:noteHint(key),value:valueOf(key),media,focus,cursor,change:v=>writeValue(key,v),
      commit:close,escape:close,attach:async(files,alive)=>{
        const data=await decodeFiles(files);
        if (!alive() || store.answers!==a) return [];
        const ids=data.map(png=>registerImage(owner,png));
        store.edited(); return ids;
      }});
  }

  // 全体へのコメントのページでは、依頼の宛先から元のセクションの同じ依頼まで移れる。
  function targetLink(r,full) {
    const label=esc(model.targetLabel(r.target,store.answers));
    if (!full) return '';
    if (r.target === WHOLE) return `<span>${label}</span>`;
    const destination = named(r.target)?.id ?? SETTLED;
    return `<a class="request-target" href="#${esc(destination)}" data-request-target="${r.id}" data-goto="${esc(destination)}">${label}</a>`;
  }
  function entry(r,full) {
    // 依頼と画像の番号（R-01・U-01）は回答ファイルでだけ使い、画面には出さない。
    const loose=r.attachments.filter(id=>!r.text.includes('!['+id+']'));
    const links = loose.map((id, i) => {
      const name = nameOf(id);
      if (full) return `<figure data-image-ref="${id}" data-unnamed="添付した画像">${photo(id, '添付した画像', name)}${imageCaption(name)}</figure>`;
      const fallback = '画像' + (loose.length > 1 ? ' ' + (i + 1) : '');
      return `<button type="button" class="image-link" data-open="${id}" data-image-ref="${id}" data-unnamed="${fallback}"${imageTip(name)}>${esc(name || fallback)}</button>`;
    }).join('');
    return reviewItem('requests', r.id, `<article class="request-item${full?' full':''}" data-request="${r.id}"><div class="request-content">${full ? `<header>${targetLink(r,full)}</header>` : ''}<div class="request-text formatted">${bodyHtml(r.text)}</div>${threadSlot('requests', r.id)}${links?'<div class="thumbs">'+links+'</div>':''}</div>
      <div class="request-actions" data-review-actions><button type="button" data-edit-request="${r.id}">編集</button>${full?`<button type="button" data-delete-request="${r.id}">削除</button>`:''}</div><div data-request-editor></div></article>`);
  }
  function previewRequest(id) {
    const draft=view().requestDrafts?.[id], record=store.answers.requests.find(r=>r.id===id);
    if (!record) return;
    for (const el of all(`[data-request="${id}"]`)) {
      const button=$('[data-edit-request]',el);
      button.textContent=draft?'下書きの編集を続ける':'編集';
      const text = $('.request-text', el);
      text.innerHTML = richHtml(draft?.text ?? record.text,
        key => draftImage(draft, key)?.dataUrl ?? media(key), key => forms.imageNameAt(text, key));
    }
  }
  function renderRequests(page, force) {
    const a = store.answers;
    const seen = page._requests;
    if (!force && seen?.requests === a.requests && seen.users === a.userSections && seen.archived === a.archived) return;
    page._requests = {requests: a.requests, users: a.userSections, archived: a.archived};
    const list = visibleRequests().reverse();
    const full = $('[data-requests="all"]', page);
    if (full) full.innerHTML = list.map(r => entry(r, true)).join('');
    for (const host of all('[data-section-requests]', page)) {
      const local = list.filter(r => r.target === host.dataset.sectionRequests);
      host.innerHTML = local.length ? '<h3>このセクションへの依頼</h3>' + local.map(r => entry(r, false)).join('') : '';
    }
    for (const id of Object.keys(view().requestDrafts ?? {})) previewRequest(id);
  }
  function renderAttachments(page) {
    const a=store.answers;
    for (const host of all('[data-attachments]', page)) {
      const target=host.dataset.attachments, section=a.userSections.find(s=>s.id===target);
      const ids=[...new Set([...Object.keys(a.attachments).filter(id=>a.attachments[id].section===target),...(section?.attachments ?? [])])];
      for (const old of all('[data-attachment]',host)) if (!ids.includes(old.dataset.attachment)) old.remove();
      for (const id of ids) {
        const existing=host.querySelector(`[data-attachment="${id}"]`);
        const inBody=section?.body.includes('!['+id+']');
        if (existing) {existing.classList.toggle('inline-attachment',Boolean(inBody));continue;}
        const name = nameOf(id);
        host.insertAdjacentHTML('beforeend',`<figure class="attachment${inBody?' inline-attachment':''}" data-attachment="${id}" data-image-ref="${id}">${photo(id,'追加した画像',name)}<figcaption>${imageCaption(name, true)}<button class="text-button" data-delete-image="${id}">削除</button></figcaption>${marks(id)}${slot('attachments', id, '画像の説明を書く')}</figure>`);
      }
    }
  }
  function updateBulkButtons(page) {
    const buttons = all('[data-bulk]', page);
    if (!buttons.length) return;
    const count = activeDecisions.filter(d => canFillDecision(d, store.answers.decisions[d.id])).length;
    for (const button of buttons) {
      button.hidden = count === 0;
      button.textContent = `未回答の ${count} 件を推奨で埋める`;
    }
  }

  function showSummary(cell, d) {
    const text = decisionSummary(d, store.answers.decisions[d.id]);
    if (cell.textContent !== text) cell.textContent = text;
  }

  function decisionEdited(d, host, refit = false) {
    store.edited();
    if (showDecisionAnswer(host, d, store.answers.decisions[d.id]) || refit) fitDecisionControls(host);
    const page = sheet();
    for (const cell of all(`[data-current="${d.id}"]`, page)) showSummary(cell, d);
    updateBulkButtons(page);
    progress(d.section);
  }
  // セクションを完了にしても、以前に書いたコメントと返事は一覧の内側から読める。
  function archivedNotes(page) {
    const a = store.answers;
    for (const host of all('[data-archived-notes]', page)) {
      const s = doc.sections.find(s => s.id === host.dataset.archivedNotes);
      const notes = [], images = new Set(doc.issues.filter(i => i.file && i.sections.includes(s.id)).map(i => i.id));
      function note(kind, id, label) {
        if (a[kind][id] || model.threads(a, model.addresses.key(kind, id)).length) {
          notes.push(`<div class="archived-note"><small>${esc(label)}</small>${slot(kind, id)}</div>`);
        }
      }
      for (const row of s.rows) {
        note('rows', row.id, row.title);
        for (const id of row.mocks) note('mocks', id, row.mockTitles?.[id] ?? row.title);
      }
      for (const id of model.figuresInSection(s.id)) images.add(id);
      for (const id of images) {
        if (a.photos[id] || a.pins[id]?.items.length || model.threads(a, model.addresses.key('photos', id)).length) {
          notes.push(`<div><button class="text-button" data-open="${id}">${esc(model.picture(a, id).title)}</button>${marks(id)}${a.photos[id] ? '' : slot('photos', id)}</div>`);
        }
      }
      const content = notes.join('') + `<div data-attachments="${s.id}"></div><div data-section-requests="${s.id}"></div>`;
      if (host._notes !== content) { host.innerHTML = content; host._notes = content; page._requests = undefined; }
    }
  }
  function refreshThreads(root = document) {
    for (const host of all('[data-thread-kind]', root)) renderThread(host, model, store.answers);
    for (const host of all('.follow-up[data-field]', root)) renderSlot(host);
  }

  const imageKind = id => store.answers.attachments[id] ? 'attachments' : 'photos';
  const markVisible = (id, mark) => !store.answers.archived?.[model.addresses.key(imageKind(id), id) + '　' + markName(mark)];

  function presentItem(host) {
    const a = store.answers;
    const {reviewKind: kind, reviewId: id, reviewMark: mark} = host.dataset;
    const base = model.addresses.key(kind, id), key = mark ? base + '　' + mark : base;
    const user = kind === 'sections' && a.userSections.find(s => s.id === id);
    let original;
    if (mark) original = a.pins[id]?.items.find(p => markName(p) === mark)?.comment;
    else if (kind === 'requests') original = a.requests.find(r => r.id === id)?.text;
    else if (user) original = user.body || user.title;
    else original = valueOf((kind === 'sectionNotes' ? 'sections' : kind) + ':' + id);

    // セクション全体の操作は、会話を閉じても使えるよう題名行に置いてある。
    const canArchive = !user && !host.closest('.rv-pop') && Boolean(kind === 'requests' || mark || original || model.threads(a, key).some(item => item.comment)
      || (model.resolvedLabel(key) && model.addresses.targets(a).has(key)));
    presentReview(host, key, model, a, canArchive, original);
  }

  function presentItems(root) {
    const a = store.answers;
    for (const host of all('[data-review-kind]', root)) presentItem(host);
    for (const button of all('[data-write]:not(.note)', root)) {
      if (button.closest('[data-field]')) continue;
      const [kind, id] = button.dataset.write.split(':');
      button.hidden = Boolean(a.archived?.[model.addresses.key(kind, id)]);
    }
    for (const menu of all('.comment-menu', root)) {
      menu.previousElementSibling.hidden = !menu.querySelector('button:not([hidden])');
    }
  }

  function filedList(page) {
    const host = $('.filed-list', page), a = store.answers;
    if (!host) return;
    host.hidden = !Object.keys(a.archived ?? {}).length;
    if (host.hidden) return;
    const content = [...model.archivedItems(a)].map(([key, entries]) => {
      const title = model.filedTitle(a, key);
      const status = model.resolvedLabel(key);
      const items = entries.map(item => `<div data-filed-address="${esc(item.id)}">${item.text ? '<p>' + esc(item.text) + '</p>' : ''}
        ${item.reply.map(reply => `<p class="filed-reply">${esc(reply.trim())}</p>`).join('')}</div>`).join('');
      return `<li><div><strong>${esc(title)}</strong>${status ? `<small class="filed-status">${status}</small>` : ''}${items}</div><button type="button" class="text-button" data-restore="${esc(key)}" data-origin="${esc(entries[0].owner)}">戻す</button></li>`;
    }).join('');
    const list = $('ul', host);
    if (list._content !== content) { list.innerHTML = content; list._content = content; }
  }

  function refreshPage(page, force = false) {
    forms.renderSection(page);
    showEditionReplies($('.edition-replies', page), doc, model, store.answers);
    if (page.dataset.section === SETTLED) archivedNotes(page);
    renderRequests(page, force);
    renderAttachments(page);
    for (const el of all('[data-field]', page)) renderSlot(el, force);
    for (const button of all('[data-approve-section]', page)) {
      button.setAttribute('aria-pressed', String(store.answers.approvedSections[button.dataset.approveSection] === true));
    }
    for (const el of all('[data-settled-answer]', page)) {
      const d = decisions.get(el.dataset.settledAnswer);
      el.textContent = '→ ' + model.settledSummary(store.answers, d);
    }
    for (const host of all('[data-controls]', page)) {
      const d = decisions.get(host.dataset.controls);
      if (showDecisionAnswer(host, d, store.answers.decisions[d.id])) fitDecisionControls(host);
    }
    for (const cell of all('[data-current]', page)) showSummary(cell, decisions.get(cell.dataset.current));
    updateBulkButtons(page);
    for (const badge of all('[data-issue-marks]', page)) {
      const n=store.answers.pins[badge.dataset.issueMarks]?.items.filter(mark => markVisible(badge.dataset.issueMarks, mark)).length ?? 0;
      badge.hidden=!n; badge.textContent='印 '+n+'件';
    }
    for (const host of all('[data-marks]', page)) {
      const id=host.dataset.marks, a=store.answers, pic=a.photos[id];
      const kind = a.attachments[id] ? 'attachments' : 'photos';
      const contents = (a.pins[id]?.items ?? []).filter(p => markVisible(id, p)).map(p=>`<li>${reviewComment(kind, id, `<button type="button" class="mk" data-open="${id}" data-number="${p.number}" aria-label="${esc(a.attachments[id] ? nameOf(id) || '追加した画像' : id)} の${markName(p)}を編集"><em>${markName(p)}</em><span>${bodyHtml(p.comment || '一言なし')}</span></button>`, markName(p))}</li>`).join('')
        +(pic && !a.archived?.[model.addresses.key(kind, id)] ? `<li>${reviewComment(kind, id, `<button type="button" class="mk" data-open="${id}"><em>説明</em><span>${bodyHtml(pic)}</span></button>`)}</li>`:'');
      if (host._marks !== contents) { host.innerHTML = contents; host._marks = contents; }
    }
    refreshThreads(page);
    presentItems(page);
    if (page.dataset.section === SETTLED) filedList(page);
    setImages(page);
    drawThumbs(store.answers, markVisible, page);
    refreshImageNames(undefined, page);
  }

  function refresh(force = false) {
    navigation(force);
    progress();
    const page = sheet();
    if (page) refreshPage(page, force);
    const viewer = $('.photo-zoom[open]');
    if (viewer) {
      for (const el of all('[data-field]', viewer)) renderSlot(el, force);
      refreshThreads(viewer);
      presentItems(viewer);
      refreshImageNames(undefined, viewer);
    }
  }
  // 同じ番号でも別々の下書きでは別の仮画像を指す。各表示元の名前を引き直し、開いた入力欄は保持する。
  function refreshImageNames(id, root = document) {
    const selector = id ? `[data-image-ref="${id}"]` : '[data-image-ref]';
    for (const ref of all(selector, root)) {
      const name = forms.imageNameAt(ref, ref.dataset.imageRef), fallback = ref.dataset.unnamed || '追加した画像';
      const caption = ref.querySelector(':scope > .image-name, :scope > figcaption > .image-name, :scope > .library-image > .image-name');
      if (caption) {
        caption.textContent = name || (caption.hasAttribute('data-rename-image') ? '名前を付ける' : '');
        caption.hidden = !caption.textContent;
        if (name) caption.dataset.tip = name;
        else delete caption.dataset.tip;
      }
      const img = $('img', ref), button = ref.matches('.image-link') ? ref : $(':scope > .photo', ref);
      if (img) img.alt = name || fallback;
      if (button?.matches('.image-link')) button.textContent = name || fallback;
      else if (button) button.setAttribute('aria-label', name || fallback);
      const tip = button ?? img;
      if (tip && name) tip.dataset.tip = name;
      else if (tip) delete tip.dataset.tip;
    }
  }

  function renameAttachment(id, name) {
    const attachment = store.answers.attachments[id];
    if (!attachment) return;
    attachment.name = name;
    store.edited();
    refreshImageNames(id);
  }

  function changed() {store.edited();refresh();}
  function registerImage(owner,png) {
    const a=store.answers,id=addAttachment(a,store.media,owner,png);
    const user=a.userSections.find(s=>s.id===owner);
    if (user && !user.attachments.includes(id)) user.attachments.push(id);
    return id;
  }
  async function decodeFiles(files) {
    return Promise.all(Array.from(files).map(async f=>{
      try {return await imageAsPng(f);}catch {throw Error(f.name+' を画像として読み込めませんでした');}
    }));
  }
  let uploads=Promise.resolve(), pendingUploads=0;
  function addFiles(owner,files) {
    const a=store.answers, selected=Array.from(files);
    pendingUploads++;
    uploads=uploads.then(async()=>{
      const data=await decodeFiles(selected);
      if (store.answers!==a) return;
      data.forEach(png=>registerImage(owner,png));
      changed(); notify('画像を追加しました');
    }).catch(e=>notify(e.message)).finally(()=>{ pendingUploads--; });
  }
  function resumeRequest(cursor, id = view().requestId) {
    const d=view().requestDrafts?.[id], el=d && $(`[data-request="${d.id}"]`,sheet());
    const r=d && store.answers.requests.find(r=>r.id===d.id);
    if (r && el) {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.matches('details')) parent.open = true;
      forms.editRequest(el,r,true,cursor);
    }
  }
  store=createStorage(doc,model,{assets,conflict,notify,status(s){statusState=s;topbar.status(s);editions?.sync();},
    replaced(){
      if (!ready) return;
      delete view().noteDraft;
      leaveRich();
      if ($('.photo-zoom').open) $('.photo-zoom').close();
      forms.unmountSection();
      const id=current; refresh(true); select(id,null,true);
    }});
  forms=createForms({store,model,view,current:()=>current,sections:items,notify,changed,navigate,openRich,endRich,
    updateDraftTitle,resumeRequest,previewRequest,nameOf,refreshImageNames,leaveRich});
  let photoOpenerId;
  viewer=photoViewer(store,changed,model.picture,{refresh, markVisible,
    opened(id, number, fresh = false) {
      view().viewer = {id, number};
      if (fresh) view().viewer.fresh = true;
      if (photoOpenerId) view().viewer.opener = photoOpenerId;
      store.viewEdited();
    },
    closed(){if (active?.host.closest('.photo-zoom')) endRich(active.spec.key); delete view().viewer;store.viewEdited();},
    description(container,id){
      const kind = imageKind(id);
      container.innerHTML = slot(kind, id, '画像の説明を書く');
      $('.review-comment', container).classList.add('rv-description');
      renderSlot($('.note-slot', container), true);
      refreshThreads(container); presentItems(container);
    },
    markThread(element, id, mark) {
      const kind = imageKind(id), name = markName(mark);
      element.dataset.reviewKind = kind;
      element.dataset.reviewId = id;
      element.dataset.reviewMark = name;
      element.insertAdjacentHTML('beforeend', threadSlot(kind, id, name));
      refreshThreads(element);
      presentItem(element);
    },
    hasMarkReply(id, number) {
      const image = model.addresses.key(store.answers.attachments[id] ? 'attachments' : 'photos', id);
      return ['ピン', '範囲'].some(kind => model.threads(store.answers, image + '　' + kind + number).length);
    },
    editPin(host,id,mark,close,cursor,updateSummary,discardNew) {
      const key='pin:'+id+':'+mark.number, a=store.answers, owner=current === SETTLED ? model.picture(store.answers, id).sections[0] ?? 'general' : current;
      const original = view().noteDraft?.key === key ? view().noteDraft.original : mark.comment;
      openComment(host,{key,label:markName(mark)+'への一言',value:mark.comment,media,cursor,commit:close,escape:close,leave:()=>endRich(key),
        cancel() {
          if (discardNew) return discardNew();
          mark.comment = original ?? '';
          updateSummary();
          store.edited();
          close();
        },
        change:value=>{
          mark.comment=value; updateSummary();
          store.edited();progress();
        },
        attach:async(files,alive)=>{const pngs=await decodeFiles(files); if (!alive() || store.answers!==a) return []; const ids=pngs.map(p=>registerImage(owner,p));store.edited();return ids;}});
      if (resumeMarkNote) {
        const {editor, cursor} = resumeMarkNote;
        resumeMarkNote = null;
        const slot = all('[data-field]', host.closest('.rv-pop')).find(el => el.dataset.field === editor);
        if (slot) editNote(editor, slot, cursor);
      }
    },
    leavePin(id,number) {
      if (active?.host.closest('.rv-pop') && followUpField(active.spec.key)) active.api.commit();
      endRich('pin:'+id+':'+number);
    },
  });
  function viewPhoto(id, number, {opener, cursor, edit = true, fresh = false} = {}) {
    if (!media(id)) return;
    leaveRich();
    // 同じ図でも掲載箇所ごとに説明が異なる。印は図の ID で共有し、開いた場所は表示状態にだけ残す。
    const source = opener?.dataset.photo === id ? opener : null;
    photoOpenerId = source?.id;
    const detail = source?.querySelector('img[alt]:not([alt=""])')
      ?? sheet()?.querySelector(`[data-photo="${CSS.escape(id)}"] img[alt]:not([alt=""])`);
    viewer(id, media(id), detail?.alt, number, cursor, edit, fresh);
  }

  // ツールチップ。ブラウザ標準の title ではなく、T3 Code のような暗い小窓を出す。data-tip が本文、data-tip-sub が補足。
  // 一覧の吹き出しは左の枠内で折り返し、本文の見出しを隠さない。
  const tip=document.createElement('div');
  tip.id='tip'; tip.setAttribute('role','tooltip'); tip.hidden=true;
  document.body.append(tip);
  let tipFor=null, tipTimer=0;
  function hideTip() { clearTimeout(tipTimer); tipFor=null; tip.hidden=true; tip.classList.remove('shown'); }
  function placeTip(el) {
    if (!el.isConnected || !el.dataset.tip) return hideTip();
    tip.innerHTML=esc(el.dataset.tip)+(el.dataset.tipSub ? `<small>${esc(el.dataset.tipSub)}</small>` : '');
    tip.hidden=false;
    const r=el.getBoundingClientRect(), rail=el.closest('.rail .nav, .rail .foot')?.closest('.rail');
    const railBox = rail?.getBoundingClientRect();
    tip.style.maxWidth = railBox ? Math.max(1, railBox.width - 16) + 'px' : '';
    const t=tip.getBoundingClientRect();
    let left = r.left+r.width/2-t.width/2, top = r.bottom+6;
    if (railBox) left = Math.min(left, railBox.right - t.width - 8);
    if (top+t.height>innerHeight-8) top=r.top-6-t.height;
    tip.style.left=Math.max(8,Math.min(left,innerWidth-t.width-8))+'px';
    tip.style.top=Math.max(8,Math.min(top,innerHeight-t.height-8))+'px';
    requestAnimationFrame(()=>tip.classList.add('shown'));
  }
  const tipSource=e=>e.target.closest?.('[data-tip]') ?? null;
  document.addEventListener('pointerover',e=>{
    const el=tipSource(e);
    if (el===tipFor) return;
    hideTip();
    if (!el || e.pointerType==='touch') return;
    tipFor=el; tipTimer=setTimeout(()=>placeTip(el),400);
  });
  document.addEventListener('focusin',e=>{ const el=tipSource(e); if (el && e.target.matches(':focus-visible')) { hideTip(); tipFor=el; placeTip(el); } });
  document.addEventListener('focusout',hideTip);
  document.addEventListener('pointerdown',hideTip);
  document.addEventListener('scroll',hideTip,true);
  document.addEventListener('keydown',e=>{ if (e.key==='Escape') hideTip(); });

  // 書いたコメントやコメントの宛先メニューに乗る・フォーカスすると、そのコメントの対象（行・画面案・判断・画像）を青枠で示す。
  function commentTarget(key) {
    const [kind,id]=key.split(':'), q=CSS.escape(id ?? ''), here='.sheet:not([hidden]) ';
    if (kind==='mocks') return $(`${here}[data-mock="${q}"] .mock-screen`);
    if (kind==='rows') return $(`${here}.row[data-row="${q}"] > .c`);
    if (kind==='decisions') return $(`${here}.row[data-decision-row="${q}"] > .c`);
    if (kind==='photos') return $(`${here}[data-thumb="${q}"]`);
    if (kind==='attachments') return $(`${here}[data-attachment="${q}"] .rv-frame`);
    return null;
  }
  function showTarget(el) {
    const target=el?.dataset.write ? commentTarget(el.dataset.write) : null;
    for (const t of all('.comment-target')) if (t!==target) t.classList.remove('comment-target');
    target?.classList.add('comment-target');
  }
  const targetSource=e=>e.target.closest?.('.comment-menu [data-write], .note[data-write]');
  // マウスで乗ったときと、キーボードで移ったとき（:focus-visible）だけ示す。確定後に焦点が戻っただけでは枠を残さない。
  document.addEventListener('pointerover',e=>showTarget(targetSource(e)));
  document.addEventListener('focusin',e=>{ if (e.target.matches(':focus-visible')) showTarget(targetSource(e)); });
  document.addEventListener('focusout',e=>{ if (targetSource(e)) showTarget(null); });
  function menuClose() {
    showTarget(null);
    const open=$('[data-menu][aria-expanded=true]');
    if (open) {open.setAttribute('aria-expanded','false');open.nextElementSibling.hidden=true;}
  }
  document.addEventListener('click',e=>{
    if (e.target.matches?.('.nav-item > i.m')) { e.target.previousElementSibling.click(); return; }
    const btn=e.target.closest('button,a'), f=btn?.dataset ?? {};
    if (btn?.matches('[data-menu]')) {
      const opened=btn.getAttribute('aria-expanded')==='true'; menuClose();
      if (!opened) {btn.setAttribute('aria-expanded','true');btn.nextElementSibling.hidden=false;btn.nextElementSibling.querySelector('button:not([hidden])')?.focus();}
      return;
    }
    menuClose();
    if (f.archive || f.restore) {
      const key = f.archive || f.restore;
      const group = btn.closest('[data-review-kind], .user-sheet'), restoring = Boolean(f.restore);
      // 完了にすると元のページが外れる。先に本文・題名と仮画像を同じ回答へ確定する。
      if (!forms.finishSectionEdit()) return;
      if ($('.photo-zoom').open) $('.photo-zoom').close();
      if (!restoring && active && group?.contains(active.host)) leaveRich();
      const previous = current;
      model.setArchived(store.answers, key, !restoring);
      changed();
      if (restoring && named(key) && /^S-\d+$/.test(key)) navigate(key);
      else if (!named(previous)) navigate(restoring ? f.origin : SETTLED, null, true);
      if (!btn.isConnected || !btn.checkVisibility()) {
        const next = sheet().querySelector('.filed-list [data-restore]') ?? main;
        next.focus({preventScroll: true});
      }
      notify(restoring ? '元の場所に戻しました' : '決定事項の「完了したもの」に移しました');
      return;
    }
    if (f.seeReply) { revealReply(btn); return; }
    if (f.decisionRef || f.jump) {
      if (btn.matches('a') && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return;
      e.preventDefault();
      goToQuestion(f.decisionRef ?? f.jump);
      return;
    }
    if (f.nav) {e.preventDefault();navigate(f.nav);return;}
    if (btn?.matches('[data-new-section]')) {forms.newSection('nav');return;}
    if (btn?.matches('[data-cancel-section]')) { forms.discardNew(); return; }
    if (btn?.matches('[data-publish-section]')) { forms.publishNew(); return; }
    if (btn?.matches('[data-delete-section]')) { forms.deleteSection(btn); return; }
    if (f.write) {
      const local=btn.closest('.rv-description,.attachment,.decision-card,.row,.section-tail,.index-comment');
      const host=btn.closest('[data-field]') ?? local?.querySelector(`[data-field="${f.write}"]`);
      const fold = host?.closest('.resolved-item');
      if (fold) fold.open = true;
      editNote(f.write,host);return;
    }
    if (f.requestTarget) {
      e.preventDefault();
      const jump=`.sheet[data-section="${CSS.escape(f.goto)}"] [data-request="${CSS.escape(f.requestTarget)}"]`;
      navigate(f.goto,jump);
      const found=$(jump);
      if (found) { found.classList.add('flash'); setTimeout(()=>found.classList.remove('flash'),1600); }
      return;
    }
    if (f.approveSection) {
      const a = store.answers;
      model.setSectionApproved(a, f.approveSection, a.approvedSections[f.approveSection] !== true);
      changed();
      return;
    }
    if (f.editRequest) {
      const entry=btn.closest('[data-request]'), r=store.answers.requests.find(r=>r.id===f.editRequest);
      forms.editRequest(entry,r);return;
    }
    if (f.deleteRequest) {
      removeRequest(store.answers,f.deleteRequest);
      if (view().requestDrafts) delete view().requestDrafts[f.deleteRequest];
      changed();store.viewEdited();notify('依頼を削除しました');return;
    }
    if (btn?.matches('figcaption [data-rename-image]')) {
      const id = btn.closest('[data-attachment]').dataset.attachment;
      editImageName(btn, nameOf(id), name => renameAttachment(id, name));
      return;
    }
    if (f.deleteImage) {
      leaveRich();
      removeAttachment(store.answers,store.media,f.deleteImage);
      for (const d of [...Object.values(view().requestDrafts ?? {}),...Object.values(view().sectionDrafts ?? {})].filter(Boolean)) {
        if (Object.hasOwn(d.images,f.deleteImage)) continue;
        if (d.renames) delete d.renames[f.deleteImage];
        d.text=d.text.replaceAll('!['+f.deleteImage+']','');d.attachments=d.attachments.filter(id=>id!==f.deleteImage);
      }
      forms.unmountSection(); changed(); forms.renderSection(sheet());
      store.viewEdited();notify('画像を削除しました');return;
    }
    if (btn?.hasAttribute('data-bulk')) {
      const {chosen} = counts(store.answers, activeDecisions);
      const {count, undo} = store.fillRecommendations();
      if (!count) return;
      refresh();
      notify(`${count} 件を推奨で埋めました。答えた ${chosen} 件はそのままです。`, 6500, () => {
        undo();
        refresh();
        if (!btn.hidden && sheet()?.contains(btn)) btn.focus({preventScroll: true});
      });
      return;
    }
    if (f.photo || f.open) {
      viewPhoto(f.photo ?? f.open, Number(f.number), {opener: btn});
      return;
    }
    const inline=e.target.closest('.inline-image');
    // 作成中のセクションの画像は仮番号なので、同じ番号の保存済み画像を開かない。
    if (inline && current !== DRAFT_PAGE && !inline.closest('[contenteditable],.note,dialog')) viewPhoto(inline.dataset.inline);
  });
  document.addEventListener('keydown',e=>{
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const open = $('[data-menu][aria-expanded=true]');
    if (open) { e.preventDefault(); menuClose(); open.focus(); }

  });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'e'
        || !sheet()?.classList.contains('user-sheet') || $('dialog[open]') || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat) {
      event.target.closest?.('.user-sheet .image-name-input')?.blur();
      forms.setSectionMode(sheet(), sheet().classList.contains('editing') ? 'view' : 'edit');
    }
  }, true);
  main.addEventListener('change',e=>{
    const el=e.target;
    if (el.dataset.sectionMode) forms.setSectionMode(sheet(), el.dataset.sectionMode);
    else if (el.dataset.choice) {
      const d = decisions.get(el.dataset.choice);
      setDecisionChoice(store.answers, d, el.value, {itemId: el.dataset.itemId, checked: el.checked});
      decisionEdited(d, el.closest('[data-controls]'), true);
      const otherField = el.closest('.decision-option').querySelector('[data-other-field]:not([hidden])');
      if (otherField) revealInput(otherField);
    }
  });
  main.addEventListener('input', e => {
    const id = e.target.dataset.otherText;
    if (!id) return;
    setOtherText(store.answers.decisions[id], e.target.value);
    decisionEdited(decisions.get(id), e.target.closest('[data-controls]'));
  });
  function attachToPage(files) {
    if (current === DRAFT_PAGE) forms.attachToSection(files);
    else addFiles(current === SETTLED ? 'general' : current, files);
  }
  main.addEventListener('dragover',e=>{if (e.dataTransfer.types.includes('Files')) e.preventDefault();});
  main.addEventListener('drop',e=>{
    if (!e.defaultPrevented && e.dataTransfer.files.length) {e.preventDefault();attachToPage(e.dataTransfer.files);}
  });
  document.addEventListener('paste',e=>{
    if (!e.defaultPrevented && !e.target.closest('dialog,input,textarea') && e.clipboardData.files.length) {
      e.preventDefault();attachToPage(e.clipboardData.files);
    }
  });
  selector.onchange=()=>{
    if (selector.value==='@new') {selector.value=current;forms.newSection('nav');}
    else navigate(selector.value);
  };
  $('#prev-section').onclick=()=>navigate(pages()[selector.selectedIndex-1].id);
  $('#next-section').onclick=()=>navigate(pages()[selector.selectedIndex+1].id);
  const isComment = editor => editor?.host.matches('[data-field]') || editor?.spec.key.startsWith('pin:');
  // 自由記述や操作例の欄はフォーカスだけでも開く。入った時の値と比べ、実際に入力した間だけ待つ。
  const inputValue = field => field.value ?? field.textContent;
  let focusedInput, inputBefore, composingField;
  document.addEventListener('focusin', ({target}) => {
    const plainInput = target.matches('textarea, input:not([type]), input[type="text"]') && !target.readOnly;
    const demoEditor = target.isContentEditable && !target.closest('[data-rich], [data-section-field]');
    focusedInput = plainInput || demoEditor ? target : null;
    if (focusedInput) inputBefore = inputValue(focusedInput);
  });
  document.addEventListener('compositionstart', ({target}) => { composingField = target; }, true);
  document.addEventListener('compositionend', () => { composingField = null; }, true);

  function draftReason() {
    const note = view().noteDraft;
    if (active?.host.isConnected && note && active.spec.key === note.key && draftTextChanged(note.text, note.original)) {
      if (note.key.startsWith('decisions:')) return note.key.slice('decisions:'.length) + ' のコメント';
      return active.spec.label;
    }
    if (focusedInput && focusedInput === document.activeElement && draftTextChanged(inputValue(focusedInput), inputBefore)) {
      if (focusedInput.dataset.otherText) return focusedInput.dataset.otherText + ' の自由記述';
      return focusedInput.getAttribute('aria-label') ?? '入力中の欄';
    }
    return formDraftLabel(view(), store.answers) || (processingImages() ? '取り込み中の画像' : '');
  }

  // IME の変換や画像の位置決め、削除の確認は画面にしかない。操作が終わったら自動で再開する。
  const interacting = () => composingField === document.activeElement
    || Boolean($('.rv-draft, .photo-zoom.rv-placing, #delete-section-dialog[open]'));

  function switchBlocked(message, where) {
    const field = where === 'folder' ? $('#save-status') : active?.api.txt ?? sheet()?.querySelector('[contenteditable]') ?? main;
    field.scrollIntoView({block: 'nearest'});
    if (!field.hasAttribute('tabindex') && !field.isContentEditable) field.tabIndex = -1;
    field.focus({preventScroll: true});
    notify(message, 5500);
  }

  const processingImages = () => Boolean(pendingUploads || active?.api.isBusy() || forms.sectionBusy());

  async function prepareSwitch() {
    // デコードした画像が下書きに入ってから端末へ保存する。確定操作は利用者に任せる。
    while (processingImages()) {
      const field = active?.api.txt ?? sheet()?.querySelector('[data-section-field="body"]') ?? main;
      field.scrollIntoView({block: 'nearest'});
      notify('画像を読み込み中です。取り込みが終わると更新します。', 5500);
      await Promise.all([uploads, active?.api.settled(), forms.sectionSettled()]);
    }
    store.viewEdited();
  }

  async function manualSave() {
    if (!ready) return;
    // フォルダの選択にはキー入力直後の操作権限が必要。画像の読み込み待ちは選択後に行う。
    const comment = isComment(active) ? active : null;
    const time = await store.saveNow(async () => {
      if (comment?.api.isBusy()) await comment.api.settled();
      if (comment && active === comment) {
        comment.host.querySelector('.image-name-input')?.blur();
        comment.api.commit();
      }
    });
    if (time) notify('保存しました　' + time);
  }
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!event.repeat && !$('#conflict[open], #delete-section-dialog[open]')) manualSave();
  }, true);
  $('#copy').onclick = async () => {
    const markdown = model.markdown(store.answers, {copy:true});
    try {
      await navigator.clipboard.writeText(markdown);
      notify('回答をコピーしました');
    } catch {
      const dialog = $('#copy-dialog'), field = $('#copy-text');
      field.value = model.markdown(store.answers, {preview:true});
      // 全選択では通常のコピーと同じ、管理番号と座標を含む文面を渡す。
      // 一部だけを選んだ場合は、その選択範囲をブラウザーにコピーさせる。
      field.oncopy = event => {
        if (!event.clipboardData || field.selectionStart !== 0 || field.selectionEnd !== field.value.length) return;
        event.clipboardData.setData('text/plain', markdown);
        event.preventDefault();
      };
      dialog.showModal();
      field.focus(); field.select();
      // 全文を選んだまま、長い回答も見出しから読める位置で表示する。
      field.scrollTop = 0;
      // 埋め込みプレビューで旧コピーAPIも拒まれた場合は、選択済みの本文を残す。
      try {
        if (document.execCommand('copy')) { dialog.close(); notify('回答をコピーしました'); }
      } catch { /* 「回答をコピー」ダイアログから手動でコピーできる。 */ }
    }
  };
  $('#download').onclick = () => {
    const json = JSON.stringify(portableAnswers(store.snapshot()),null,2) + '\n';
    const url = URL.createObjectURL(new Blob([json], {type:'application/json'}));
    const a = document.createElement('a');
    a.href = url; a.download = 'answers.json'; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  editions = watchEditions(doc, {folder: () => ready ? store.connectedFolder() : null, pendingSave: store.pendingSave,
    draftReason, interacting, processingImages, prepare: prepareSwitch, blocked: switchBlocked, flush: store.flushForReload, position: () => ({section: current, scroll: main.scrollTop}),
    offer: topbar.offerEdition});
  await store.init();
  forms.migrateSectionForm();
  const saved={...view(), cursor:view().cursor?.slice()};
  if (editions.arrival) {
    saved.section = editions.arrival.section;
    saved.scroll = editions.arrival.scroll;
    if (location.hash.slice(1) !== saved.section) history.replaceState(history.state, '', '#' + saved.section);
  }
  navigation(true);
  progress();
  if (doc.script) {
    // 既存の操作例は起動時に document から別々の章の要素を探す。一度だけ、従来と同じ DOM を渡す。
    for (const page of sheets.children) {
      mountSheet(page);
      refreshPage(page);
    }
    installDemo({
      get: id => view().examples?.[id],
      set(id, value) { (view().examples ??= {})[id] = value; store.viewEdited(); },
    });
    restoreDisclosures(sheets);
  }
  const explicit=location.hash.slice(1);
  const restored=!explicit || explicit===saved.section;
  const first = explicit || saved.section || firstSection.id;
  if (explicit.startsWith('decision-') && decisions.has(explicit.slice('decision-'.length))) route();
  else select(first,null,true);
  if (!explicit && saved.section===first) history.replaceState(null,'','#'+first);
  topbar.status(statusState);
  if (restored) {
    if (saved.viewer && media(saved.viewer.id)) {
      if (saved.viewer.number && saved.editor && followUpField(saved.editor)) resumeMarkNote = saved;
      const opener = saved.viewer.opener && document.getElementById(saved.viewer.opener);
      viewPhoto(saved.viewer.id, saved.viewer.number, {opener, cursor: saved.cursor, edit: Boolean(saved.editor), fresh: saved.viewer.fresh});
      if (!saved.viewer.number && saved.editor) {
        const host = all('[data-field]', $('.photo-zoom')).find(el => el.dataset.field === saved.editor);
        if (host) editNote(saved.editor,host,saved.cursor);
      }
    } else if (saved.editor?.startsWith('request:')) resumeRequest(saved.cursor);
    else if (saved.editor) {
      const host=all('[data-field]',sheet()).find(el=>el.dataset.field===saved.editor);
      if (host) {
        for (let el = host.parentElement; el; el = el.parentElement) if (el.matches('details')) el.open = true;
        editNote(saved.editor,host,saved.cursor);
      }
    }
  }
  if (restored && (saved.scroll || editions.arrival) && current === saved.section) {
    await Promise.all(all('img',sheet()).map(img=>img.decode().catch(()=>{})));
    main.scrollTop=saved.scroll;
  }
  if (explicit && location.hash.slice(1) !== current) route();
  // 印刷は未訪問の章も原稿順に使う。選択中の章・スクロール・編集中の欄は切り替えない。
  window.addEventListener('beforeprint', () => {
    for (const page of sheets.children) {
      if (!page.hidden) continue;
      mountSheet(page);
      refreshPage(page);
    }
  });
  window.addEventListener('hashchange',route);
  main.addEventListener('scroll',()=>{view().scroll=main.scrollTop;store.viewEdited();},{passive:true});
  ready=true;
  if (editions.arrival) notify(`第${doc.built.number}回に更新しました`);
  editions.sync();
  $('#copy').disabled=$('#download').disabled=false;
  if (window.__REVIEW_KIT_TEST_MODE__===true) window.reviewKitTest=Object.freeze({connectDirectory:handle=>store.connect(handle)});
}
