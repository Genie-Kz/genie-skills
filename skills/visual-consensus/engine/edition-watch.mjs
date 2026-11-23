// 保存先から回の情報を読むだけなので、file:// の資料でも通信や新しい許可を必要としない。
async function readMarker(dir, visibleFolder) {
  try {
    if (await dir.queryPermission({mode: 'readwrite'}) !== 'granted' || dir !== visibleFolder()) return null;
    const file = await dir.getFileHandle('.edition.json');
    const marker = JSON.parse(await (await file.getFile()).text());
    if (!Number.isSafeInteger(marker?.number) || marker.number < 1 || typeof marker.hash !== 'string' || !/^[a-f0-9]{64}$/.test(marker.hash)) return null;
    const revision = marker.revision === undefined ? 0 : marker.revision;
    if (Number.isSafeInteger(revision) && revision >= 0) return {number: marker.number, revision, hash: marker.hash};
  } catch { /* 古い資料、許可待ち、差し替え中のファイルは次の確認まで待つ。 */ }
  return null;
}

// 旧 HTML と旧形式の切替記録には手直し番号がない。
function compareEditions(a, b) {
  return a.number - b.number || (a.revision ?? 0) - (b.revision ?? 0);
}

// 同じタブで古い HTML が再び開かれても、試した回と手直し番号を引き継ぐ。
function reloadState(id) {
  const key = 'review-kit/edition/' + location.pathname + '/' + id;
  const suffix = '\n' + key + '=';
  let state = {sequence: 0, tried: []};
  // 保存途中で一方だけ使えなくなっても、書けた側の新しい試行や通知済みの記録を採用する。
  function read(value) {
    if (Number.isSafeInteger(value?.sequence) && value.sequence > state.sequence && Array.isArray(value.tried)) state = value;
  }
  try { read(history.state?.[key]); } catch { /* タブの記録を使う。 */ }
  try { read(JSON.parse(sessionStorage.getItem(key))); } catch { /* 履歴を使う。 */ }
  if (window.name.includes(suffix)) {
    try { read(JSON.parse(window.name.split(suffix).at(-1))); } catch { /* 以前の記録を読めない。 */ }
  }
  const tried = new Set(state.tried);
  let sequence = state.sequence;
  function write(arrival) {
    const value = {sequence: ++sequence, tried: [...tried], arrival};
    let saved = false;
    try { sessionStorage.setItem(key, JSON.stringify(value)); saved = true; } catch { /* 履歴を使う。 */ }
    try { history.replaceState({...history.state, [key]: value}, ''); saved = true; } catch { /* タブの記録を使う。 */ }
    // 位置を復元する記憶域が両方制限されても、同じタブの名前で再読み込みの繰り返しを防ぐ。
    if (!saved || window.name.includes(suffix)) {
      const base = window.name.split(suffix)[0];
      try { window.name = saved ? base : base + suffix + JSON.stringify(value); saved = true; } catch { /* 記録できなければ再試行を止める。 */ }
    }
    return saved;
  }
  const arrival = state?.arrival;
  if (arrival) write(null);
  return {tried, arrival, write};
}

/** 自動の確認で、待つか、「更新」を出すかを決める。reason は書きかけの欄の名前（なければ空）。
 * 書きかけは更新後も残るので、待つのは利用者がこの画面で書いている間だけ。別のウィンドウ（チャットなど）に
 * 移っている間は、「更新」を押したときと同じく書きかけを残して開き直す。取り込み中の画像は下書きに入る前なので、
 * どこにいても終わるまで待つ。
 */
export function autoUpdateState({reason, focused, pending, interacting, processing}) {
  const offer = Boolean(reason) && focused;
  return {offer, wait: offer || pending || interacting || processing};
}

/** 接続済みのフォルダを表示中だけ監視する。arrival は実際に新しい回を開けたときの復元位置。
 * sync は保存先や表示状態が変わったとき、accept は利用者が「更新」を押して書きかけを次の回に引き継ぐときに呼ぶ。
 */
export function watchEditions(doc, {folder, pendingSave, draftReason, interacting, processingImages, prepare, blocked, flush, position, offer}) {
  const {tried, arrival, write} = reloadState(doc.id);
  const built = doc.built;
  const order = arrival && compareEditions(built, arrival);
  const arrived = arrival && (order > 0 || (order === 0 && built.hash === arrival.hash));
  const visibleFolder = () => document.visibilityState === 'visible' ? folder() : null;
  let watched = null, timer, checking, navigating = false;

  function waitForInput(number) {
    const reason = draftReason();
    const state = autoUpdateState({reason, focused: document.hasFocus(), pending: pendingSave(), interacting: interacting(), processing: processingImages()});
    offer(state.offer ? number : null, reason);
    return state.wait;
  }

  async function inspect(dir, manual) {
    const next = await readMarker(dir, visibleFolder);
    if (dir !== visibleFolder()) {
      if (manual && !document.hidden) blocked('保存先が変わりました。接続先を確認してください。', 'folder');
      return;
    }
    if (!next && manual) blocked('新しい回の情報を読み取れません。保存先と読み取りの許可を確認してください。', 'folder');
    // 原稿を元に戻すとハッシュは再登場する。読み込みの試行は公開した番号の組で識別する。
    const key = next && next.number + ':' + next.revision;
    if (!next || compareEditions(next, built) <= 0 || tried.has(key)) {
      offer(null);
      return;
    }
    if (manual) {
      if (pendingSave()) blocked('回答を保存しています。保存が終わると更新します。', 'folder');
    } else if (waitForInput(next.number)) return;
    const carry = manual || Boolean(draftReason());
    try {
      do {
        if (carry) await prepare();
        if (!await flush(dir) || dir !== visibleFolder()) {
          if (manual) blocked('保存先の状態を確認してください。回答を保存してから更新します。', 'folder');
          return;
        }
        // フォルダの書き込み中に別の画像を添付した場合も、新しい仮画像を端末に保存する。
      } while (manual && processingImages());
    } catch (error) {
      if (manual) blocked(error.message, error.cause === 'folder' ? 'folder' : 'draft');
      return;
    }
    // 保存を待つ間に新しい入力が始まった場合も、画面を開いたままにする。
    if ((!manual && waitForInput(next.number)) || pendingSave()) return;

    tried.add(key);
    if (!write({...next, ...position()})) {
      tried.delete(key);
      if (manual) blocked('このタブに読み込み位置を保存できません。ブラウザの保存設定を確認してください。', 'draft');
      return;
    }
    navigating = true;
    location.reload();
  }

  async function check(manual = false) {
    if (checking) {
      if (!manual) return;
      await checking;
    }
    const dir = visibleFolder();
    if (!dir && manual && !document.hidden) blocked('新しい回の保存先への接続を確認してください。', 'folder');
    if (!dir || navigating || checking) return;
    checking = inspect(dir, manual);
    try { await checking; } finally { checking = null; }
  }

  function sync() {
    const dir = visibleFolder();
    if (dir === watched) return;
    clearInterval(timer);
    offer(null);
    watched = dir;
    if (dir) {
      timer = setInterval(check, 3000);
      void check();
    }
  }
  document.addEventListener('visibilitychange', sync);
  return {arrival: arrived ? arrival : null, sync, accept: () => check(true)};
}
