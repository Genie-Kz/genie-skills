/** 保存メニューは通常のボタンで操作し、閉じた後のキー入力は元の画面に戻す。 */
export function mountTopbar(doc, {answersPath, save, choose, notify, switchEdition}) {
  const element = id => document.getElementById(id);
  const trigger = element('more'), menu = element('document-menu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:enabled')];
  const edition = element('edition');
  edition.textContent = doc.built.label;
  edition.dataset.tip = doc.built.full;
  const date = doc.built.full.split(' ')[0];

  function close(returnFocus = false) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }

  function open(last = false) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    (items().at(last ? -1 : 0) ?? menu).focus();
  }

  trigger.onclick = () => menu.hidden ? open() : close(true);
  trigger.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open(event.key === 'ArrowUp');
  };
  menu.tabIndex = -1;
  menu.onkeydown = event => {
    const available = items(), index = available.indexOf(document.activeElement);
    switch (event.key) {
      case 'Escape': close(true); break;
      case 'Tab': close(true); return;
      case 'Home': available[0]?.focus(); break;
      case 'End': available.at(-1)?.focus(); break;
      case 'ArrowDown': available[(index + 1) % available.length]?.focus(); break;
      case 'ArrowUp': available.at(index - 1)?.focus(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !trigger.parentElement.contains(event.target)) close();
  });
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !trigger.parentElement.contains(event.relatedTarget)) close();
  });

  element('switch-edition').onclick = switchEdition;
  function offerEdition(number, reason) {
    const button = element('switch-edition');
    if (number) {
      button.dataset.tip = `書きかけを残したまま、第${number}回に更新します`;
      button.dataset.tipSub = '書きかけ：' + reason;
    }
    const label = element('available-edition'), message = number ? `第${number}回があります` : '';
    element('edition-update').hidden = !number;
    if (label.textContent !== message) label.textContent = message;
  }

  element('folder').onclick = () => choose();
  element('save-now').onclick = save;
  element('menu-save').onclick = () => { close(true); save(); };
  element('change-folder').onclick = () => { close(true); choose(true); };
  const copyPath = menu.querySelector('[data-copy-path]');
  copyPath.disabled = !answersPath;
  copyPath.dataset.tip = answersPath || 'ローカルの資料を開くとパスをコピーできます';
  copyPath.dataset.tipSub = '資料の隣にある answers フォルダ';
  copyPath.onclick = async () => {
    close(true);
    try {
      await navigator.clipboard.writeText(answersPath);
      notify('保存先のパスをコピーしました（資料の隣の answers フォルダ）');
    } catch { notify('コピーできませんでした。資料の保存先は ' + answersPath); }
  };

  function progress(chosen, total, responses, deferred) {
    const decisions = '判断 ' + chosen + '/' + total;
    const count = element('progress'), meta = element('menu-meta');
    const pending = deferred ? '保留 ' + deferred : '';
    const summary = decisions + (pending ? '・' + pending : '');
    const label = [doc.built.label, date, summary, '回答 ' + responses + '件'].join(' · ');
    if (count.textContent !== summary) {
      count.textContent = decisions;
      if (pending) {
        const mark = document.createElement('span');
        mark.className = 'hold-count';
        mark.textContent = pending;
        count.append('・', mark);
      }
      const mobile = element('mobile-progress');
      mobile.replaceChildren(...[...count.childNodes].map(node => node.cloneNode(true)));
      mobile.hidden = !deferred;
    }
    if (meta.textContent !== label) meta.textContent = label;
  }

  let lastStatus;
  function status(state) {
    const {kind, message, folderName, savedAt, resume, canSave, canChange} = state;
    // 全体のページを初めて組み立てた時も、同じ二つのボタンに保存とコピーの操作を残す。
    const warning = kind === 'error' || kind === 'local-error';
    const fallback = kind === 'unavailable' || kind === 'local-error' || (!canSave && warning);
    const exports = element('answer-exports'), host = element(fallback ? 'fallback-exports' : 'general-exports');
    if (host && exports.parentElement !== host) host.append(exports);
    if (exports.hidden !== !host) exports.hidden = !host;

    if (lastStatus && Object.keys(state).every(key => state[key] === lastStatus[key])) return;
    lastStatus = state;
    const status = element('save-status'), detail = element('save-message'), footer = element('menu-status');
    const icon = warning ? 'alert' : ({saved: 'check', saving: 'history', checking: 'history', unavailable: 'alert'}[kind] ?? 'folder');
    element('status-icon').setAttribute('href', '#vc-icon-' + icon);
    const pick = element('folder'), quick = element('save-now'), focused = document.activeElement;
    const followAction = focused === pick || focused === quick || focused === status;
    status.dataset.state = kind;
    status.dataset.tip = kind === 'unselected' ? '保存先が未選択（このブラウザに一時保存）' : message;
    status.classList.toggle('warning', warning);
    if (detail.textContent !== message) detail.textContent = message;

    const lastSave = Boolean(savedAt);
    footer.textContent = lastSave ? savedAt + ' に保存済み' : message;
    footer.parentElement.classList.toggle('warning', warning);
    element('menu-status-icon').setAttribute('href', '#vc-icon-' + (lastSave ? 'check' : icon));

    pick.hidden = !canSave || ['saved', 'saving', 'checking'].includes(kind);
    pick.disabled = !canSave;
    pick.classList.toggle('resume-folder', resume);
    pick.textContent = resume ? '保存を再開' : '保存先を選ぶ';
    quick.hidden = !['saved', 'saving', 'checking'].includes(kind);
    quick.disabled = !canSave;
    // 照合中は選択ボタンが消える。ダイアログを取り消したら、再び使える保存操作へフォーカスを戻す。
    if (followAction) {
      const next = !pick.hidden && !pick.disabled ? pick : !quick.hidden && !quick.disabled ? quick : status;
      if (document.activeElement !== next) next.focus({preventScroll: true});
    }
    element('menu-save').disabled = !canSave;
    element('change-folder').disabled = !canChange;
    element('menu-folder').textContent = folderName ?? '';
  }

  return {progress, status, offerEdition};
}
