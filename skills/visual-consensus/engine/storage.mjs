import { connectionChoice, fillRecommended, pngData, signature } from 'review-kit/model';
import { photoPng } from 'review-kit/photo';

const mode = {mode: 'readwrite'};
const markedGroups = answers => Object.entries(answers?.pins ?? {}).filter(([, group]) => group.items.length);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('review-kit-v2', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('drafts');
      req.result.createObjectStore('folders');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transaction(db, store, action, write = false) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, write ? 'readwrite' : 'readonly');
    const req = action(tx.objectStore(store));
    // put の success 時点では、容量不足などでトランザクション全体が取り消される場合がある。
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? Error('ブラウザ内の保存に失敗しました'));
  });
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 画像をデコードした実寸で PNG にする。拡張子だけを変更して元の形式を残さない。 */
export async function imageAsPng(file) {
  const url = URL.createObjectURL(file);
  try {
    return await dataUrl(await photoPng(url));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pngBlob(url) {
  if (!pngData(url)) throw Error('追加画像の PNG データが見つかりません');
  const binary = atob(url.slice(url.indexOf(',') + 1));
  return new Blob([Uint8Array.from(binary, ch => ch.charCodeAt(0))], {type: 'image/png'});
}

async function jsonFile(dir) {
  try {
    const file = await (await dir.getFileHandle('answers.json')).getFile();
    return {raw: await file.text(), savedAt: file.lastModified};
  } catch (error) {
    if (error.name === 'NotFoundError') return {raw: null};
    throw error;
  }
}

async function readFolder(dir, raw, model) {
  // 初回の書き込み中に閉じると、最後に作った answers.json が空のまま残ることがある。
  if (raw === null || raw === '') return null;
  const pack = model.unpack(JSON.parse(raw));
  const missing = Object.keys(pack.answers.attachments).filter(id => !pack.media[id]);
  if (missing.length) {
    const images = await dir.getDirectoryHandle('images');
    for (const id of missing) {
      const file = await (await images.getFileHandle(id + '.png')).getFile();
      pack.media[id] = await dataUrl(new Blob([file], {type: 'image/png'}));
      if (!pngData(pack.media[id])) throw Error(id + ' の PNG を読み取れません');
    }
  }
  return pack;
}

async function writeFile(dir, name, value) {
  const file = await dir.getFileHandle(name, {create: true});
  const stream = await file.createWritable();
  try {
    await stream.write(value);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

async function previousBytes(dir, name) {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    // File は外部変更で無効になり得るため、差し戻し用の内容を先に読み切る。
    return await file.arrayBuffer();
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

function completePack(model, saved, inherited = {}) {
  const pack = model.unpack(saved.answers);
  for (const id of Object.keys(pack.answers.attachments)) {
    pack.media[id] = saved.media?.[id] ?? pack.media[id] ?? inherited[id];
    if (!pngData(pack.media[id])) throw Error(id + ' の端末内画像を読み取れません');
  }
  return pack;
}

/** 同一資料・版の回答とハンドルを別々に記録する。フォルダへの書き込みは約300msでまとめる。 */
export function createStorage(doc, model, {status, replaced, conflict, notify, assets}) {
  const key = 'review-kit/' + doc.id + '/' + doc.version;
  const journalKey = key + '/draft';
  const viewKey = key + '/view';
  // 同じ資料を別のタブでも読むとき、最後にスクロールしたタブで他方の下書きを上書きしない。
  let tabKey = viewKey;
  try {
    let id = sessionStorage.getItem(viewKey + '/tab');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(viewKey + '/tab', id); }
    tabKey = viewKey + '/' + id;
  } catch { /* sessionStorage が使えないときは資料単位の復元を続ける。 */ }
  const store = {answers: model.empty(), media: {}, workspace: {}};
  let localTimer, viewTimer, viewDirty = false, answerDirty = false, writing = false, viewStamp = 0;
  let db, knownMedia = {}, handle, active, timer, queue = Promise.resolve();
  let revision = 0, tick = 0, pending = false;
  let folderRevision = null, dbWrites = 0, expectedCopy, databaseCopy;
  const writer = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36);
  let peers;
  try {
    peers = new BroadcastChannel(key + '/answer-writes');
    peers.onmessage = ({data}) => {
      // 回答と画像の DB レコードはタブ間で共有する。別タブの確定後は以前の画像を差分の基準に使えない。
      databaseCopy = data;
      knownMedia = {};
    };
  } catch { /* タブ間通知が使えなければ、離脱時は同期ジャーナルで復元を確かめる。 */ }
  let localFailed = false, folderError = '', writeFailure;
  let connecting = false, selecting = false, resume = false, pickerBlocked = false;
  const pickerAvailable = () => typeof window.showDirectoryPicker === 'function' && window.isSecureContext && !pickerBlocked;
  const snapshot = () => ({answers: structuredClone(store.answers), media: {...store.media}});

  function show(kind, message, dir, savedAt) {
    status({kind, message, folderName: dir?.name ?? (resume ? handle?.name : undefined), savedAt, resume,
      canSave: !connecting && (Boolean(dir) || resume || pickerAvailable()), canChange: !connecting && pickerAvailable()});
  }

  function folderStatus(dir = active.dir, saving = pending) {
    const savedAt = dir === active?.dir ? active.savedAt : undefined;
    if (saving) show('saving', '保存中…', dir, savedAt);
    else show('saved', dir.name + ' に保存済み ' + savedAt, dir, savedAt);
  }

  function localOnly() {
    if (localFailed) show('local-error', '端末保存不可・コピーまたはJSON保存');
    else if (folderError) show('error', folderError);
    else if (resume) show('resume', 'フォルダ保存の再開待ち');
    else if (!pickerAvailable()) show('unavailable', 'フォルダ保存不可・コピーまたはJSON保存');
    else show('unselected', '保存先は未選択');
  }

  function journal(value) {
    try { localStorage.setItem(journalKey, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  function readJournal() {
    try { return JSON.parse(localStorage.getItem(journalKey)); } catch { return null; }
  }

  const latestAnswer = (local, stored) => local && (!stored || local.stamp > stored.stamp) ? local : stored;
  const sameCopy = (left, right) => left && right && left.stamp === right.stamp && left.writer === right.writer;

  function browserCanRestore() {
    if (!expectedCopy) return true;
    const local = readJournal(), latest = latestAnswer(local, db && databaseCopy);
    if (peers && latest === databaseCopy && sameCopy(latest, expectedCopy)) return true;
    if (!sameCopy(latest, local)) return false;
    // 別タブが同じ回答を保存していれば、書いたタブが違っても画像まで復元できればよい。
    const sameAnswers = sameCopy(local, expectedCopy) || signature(local.answers) === signature(store.answers);
    return sameAnswers && Object.entries(store.media).every(([id, png]) =>
      (local.media?.[id] ?? (peers ? knownMedia[id] : undefined)) === png);
  }

  function flushAnswers() {
    if (!answerDirty) return;
    answerDirty = false;
    const stamp = tick = Math.max(Date.now(), tick + 1);
    expectedCopy = {stamp, writer};
    const saved = {...snapshot(), ...expectedCopy};
    // 入力直後の再読込に備える。IndexedDBで確定した画像は同期ジャーナルに重複させない。
    // 先行する DB 書き込みが画像を入れ替える間は、ジャーナルだけで復元できるよう全画像を含める。
    const delta = db && !dbWrites ? Object.fromEntries(Object.entries(saved.media).filter(([id, value]) => knownMedia[id] !== value)) : saved.media;
    const inJournal = journal({...saved, media: delta});
    if (!db) {
      localFailed = !inJournal;
      if (!active && !connecting) localOnly();
      return;
    }
    dbWrites++;
    transaction(db, 'drafts', os => os.put(saved, key), true).then(() => {
      knownMedia = saved.media;
      databaseCopy = {stamp, writer};
      peers?.postMessage(databaseCopy);
      if (tick === stamp && localFailed) {
        localFailed = false;
        if (!active && !connecting) localOnly();
      }
    }).catch(() => {
      if (tick !== stamp) return;
      const failed = !journal(saved) && !inJournal;
      if (localFailed !== failed) {
        localFailed = failed;
        if (!active && !connecting) localOnly();
      }
    }).finally(() => { dbWrites--; });
  }

  function remember() {
    answerDirty = true;
    clearTimeout(localTimer);
    localTimer = setTimeout(flushAnswers, 150);
  }

  // 読む位置や編集中の依頼は端末だけに置く。選択範囲の移動では回答フォルダを書き換えない。
  let viewWrite = Promise.resolve(true);
  function flushView() {
    if (!viewDirty) return;
    viewDirty = false;
    const stamp = viewStamp = Math.max(Date.now(), viewStamp + 1);
    const value = {stamp, workspace: store.workspace};
    const pointer = {tabKey, stamp};
    function journalView() {
      localStorage.setItem(tabKey, JSON.stringify(value));
      if (viewKey !== tabKey) localStorage.setItem(viewKey, JSON.stringify(pointer));
    }
    function saveJournal() {
      try { journalView(); return true; }
      catch { notify('端末の空き容量が足りず、下書きを保存できません。'); return false; }
    }
    if (db) {
      // ページを開いたままの打鍵・スクロールは非同期DBへ。同期ジャーナルは離脱時の未完了分だけにする。
      viewWrite = transaction(db, 'drafts', os => {
        if (tabKey !== viewKey) os.put(pointer, viewKey);
        return os.put(value, tabKey);
      }, true).then(() => {
        if (unsettledView?.stamp === stamp) unsettledView = null;
        return true;
      }).catch(() => {
        // 新しい保存の後から失敗した古い書き込みでジャーナルを上書きしない。
        if (viewStamp !== stamp) return false;
        return saveJournal();
      });
      unsettledView={stamp,write:journalView};
    } else {
      viewWrite = Promise.resolve(saveJournal());
    }
  }

  function viewEdited() {
    viewDirty = true;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(flushView, 150);
  }
  let unsettledView;
  function flushLocal() {
    flushAnswers(); flushView();
    try { unsettledView?.write(); } catch { /* 離脱時もすでに開始したDB書き込みを利用する。 */ }
  }
  window.addEventListener('pagehide', flushLocal);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushLocal(); });
  window.addEventListener('beforeunload', event => {
    flushLocal();
    // この変更の回答と PNG を端末から復元できれば、残ったフォルダ書き込みは再接続時にやり直せる。
    if ((!writing && !pending) || folderRevision === revision || browserCanRestore()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  // 同じ資料を複数タブで開いた場合にも、照合からコミットまでを一つずつ実行する。
  const lock = task => navigator.locks ? navigator.locks.request(key + '/folder', task) : task();
  async function cacheHandle(value) {
    handle = value;
    if (!db) return;
    try {
      await transaction(db, 'folders', os => value ? os.put(value, key) : os.delete(key), true);
    } catch {
      if (value) notify('フォルダは今回使えます。次回は保存先を選び直してください。');
    }
  }

  async function syncMarkedImages(dir, pack, previousMedia, previousLayouts, replace) {
    const groups = markedGroups(pack.answers);
    const layouts = new Map();
    if (!groups.length && !previousLayouts.size) return layouts;
    let folder;
    try {
      const options = {create: groups.length > 0};
      const images = await dir.getDirectoryHandle('images', options);
      folder = await images.getDirectoryHandle('marks', options);
    } catch (error) {
      if (!groups.length && error.name === 'NotFoundError') return layouts;
      throw error;
    }

    for (const [id, {items}] of groups) {
      const name = id + '.png';
      // 本文だけの変更では大きな画像を描き直さない。再接続時は原本と座標から全件を再生成する。
      const layout = JSON.stringify(items.map(({number, x, y, w, h}) => [number, x, y, w, h]));
      layouts.set(id, layout);
      if (previousLayouts.get(id) === layout && pack.media[id] === previousMedia?.[id]) {
        try { await folder.getFileHandle(name); continue; }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
      }
      const source = pack.media[id] ?? assets[id];
      await replace(folder, name, await photoPng(source, items));
    }
    // 同名の私物を消さないよう、直前の回答に実際に印があった画像だけを片付ける。
    for (const id of previousLayouts.keys()) {
      if (!layouts.has(id)) await replace(folder, id + '.png', null);
    }
    return layouts;
  }

  async function commit(dir, pack, previousMedia, previousLayouts) {
    const undo = [];
    async function replace(folder, name, value) {
      const before = await previousBytes(folder, name);
      if (value === null && before === null) return;
      undo.push({folder, name, before});
      if (value === null) await folder.removeEntry(name);
      else await writeFile(folder, name, value);
    }
    let layouts;
    const raw = JSON.stringify(pack.answers, null, 2) + '\n';
    try {
      const changedImages = Object.keys(pack.answers.attachments).filter(id => pack.media[id] !== previousMedia?.[id]);
      if (changedImages.length) {
        const images = await dir.getDirectoryHandle('images', {create: true});
        for (const id of changedImages) await replace(images, id + '.png', pngBlob(pack.media[id]));
      }
      // Markdown の参照先を先に揃える。最後の JSON が失敗すれば、取り除いた印付き PNG も戻す。
      layouts = await syncMarkedImages(dir, pack, previousMedia, previousLayouts, replace);
      await replace(dir, 'answers.md', model.markdown(pack.answers));
      await replace(dir, 'answers.json', raw);
    } catch (error) {
      // 通常の書き込み失敗なら、上書き前の画像・Markdownと最後に確定したJSONを再び一組にする。
      let rollbackFailed = false;
      for (const {folder,name,before} of undo.reverse()) {
        try {
          if (before !== null) await writeFile(folder,name,before);
          else await folder.removeEntry(name);
        } catch (recovery) { if (recovery.name !== 'NotFoundError') rollbackFailed = true; }
      }
      if (rollbackFailed) throw Error(error.message + '。一部を元に戻せませんでした。手元の回答からフォルダを選び直してください');
      throw error;
    }
    // 成功時刻は最後の JSON を閉じた後に採る。待機・再試行・差し戻しでは進めない。
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    const savedAt = pad(now.getHours()) + ':' + pad(now.getMinutes());
    return {dir, raw, media: pack.media, layouts, savedAt};
  }

  function apply(pack) {
    store.answers = pack.answers;
    store.media = pack.media;
    revision++;
    remember();
    replaced();
  }

  async function reconcile(dir, {raw, savedAt}) {
    const disk = await readFolder(dir, raw, model);
    for (;;) {
      const reviewedRevision = revision;
      const local = snapshot();
      let choice = connectionChoice(local, disk);
      if (choice === 'ask') {
        // 入力直後に照合を開いた場合も、画面に出す時刻と比較した回答をそろえる。
        flushAnswers();
        choice = await conflict(local, disk, {local: expectedCopy?.stamp, disk: savedAt});
      }
      if (choice === 'cancel') {
        active = null;
        pending = false;
        resume = false;
        await cacheHandle(null);
        localOnly();
        return;
      }
      // 照合中に元ファイルや入力が変われば、古い選択で新しい内容を消さない。
      if ((await jsonFile(dir)).raw !== raw) throw Error('確認中にフォルダの内容が変わりました。保存先をもう一度選んでください');
      if (reviewedRevision !== revision) continue;
      if (choice === 'disk' || choice === 'read') {
        apply(disk);
        folderRevision = revision;
      }
      break;
    }
    const before = revision, pack = snapshot();
    // 持ち運び用JSONは画像を内蔵する。接続したらまずPNGを展開してから通常のJSONへ書き戻す。
    const embedded = raw && raw.includes('"dataUrl"');
    // 再接続先の JSON から以前の印を特定する。配置は未照合なので残す画像も描き直す。
    const previousLayouts = new Map(markedGroups(disk?.answers).map(([id]) => [id, null]));
    writing = true;
    folderStatus(dir, true);
    try {
      active = await commit(dir, pack, embedded ? {} : disk?.media, previousLayouts);
      folderRevision = before;
    }
    finally { writing = false; }
    await cacheHandle(dir);
    resume = false;
    pending = before !== revision;
    folderStatus();
    if (pending) schedule();
    return active.savedAt;
  }

  function folderFailure(error, dir = active?.dir ?? handle) {
    writeFailure = error;
    active = null;
    pending = false;
    // 切り替え先で許可を失ったら、そのフォルダに対して許可を取り直す。
    resume = typeof dir?.requestPermission === 'function' && error.name === 'NotAllowedError';
    if (resume) handle = dir;
    folderError = resume ? '保存失敗・保存の許可が必要です' : 'フォルダへの保存に失敗しました';
    localOnly();
    notify('フォルダへの保存を停止しました。' + error.message);
  }

  async function connect(dir) {
    clearTimeout(timer);
    connecting = true;
    folderError = ''; writeFailure = null;
    show('checking', '回答フォルダを照合中', dir);
    try {
      return await enqueue(() => lock(async () => {
        active = null;
        return reconcile(dir, await jsonFile(dir));
      }));
    } catch (error) { folderFailure(error, dir); }
    finally {
      connecting = false;
      if (active) folderStatus();
      else localOnly();
    }
  }

  function writeFolder() {
    return enqueue(() => lock(async () => {
      if (!active || connecting) return;
      // 先行する書き込みが終わってからロックを取った手動保存も、実行中は保存中と表示する。
      pending = true;
      folderStatus();
      const {dir, raw, media, layouts} = active;
      const file = await jsonFile(dir);
      if (file.raw !== raw) {
        active = null;
        return reconcile(dir, file);
      }
      const before = revision;
      active = await commit(dir, snapshot(), media, layouts);
      folderRevision = before;
      pending = before !== revision;
      folderStatus();
      return active.savedAt;
    })).catch(folderFailure);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(writeFolder, 300);
  }

  function scheduleAnswerSave() {
    revision++;
    remember();
    if (active && !connecting) {
      pending = true;
      folderStatus();
      schedule();
    } else if (!connecting) localOnly();
  }

  function edited() {
    model.recordEdition(store.answers);
    scheduleAnswerSave();
  }

  /** 一括入力を直後に取り消すと、回答回・返事・旧形式の了承も入力前の保存内容に戻る。 */
  function fillRecommendations() {
    const answers = store.answers;
    const history = {};
    for (const key of ['answeredEdition', 'threads', 'approvedSections']) {
      if (Object.hasOwn(answers, key)) history[key] = structuredClone(answers[key]);
    }
    const fill = fillRecommended(answers, model.activeDecisions);
    if (fill.count) edited();
    const filledRevision = revision;
    return {count: fill.count, undo() {
      if (answers !== store.answers) return;
      fill.undo();
      // 別の欄が後から編集した履歴は保持する。差し戻した履歴は今回の版として再記録しない。
      if (filledRevision === revision) {
        delete answers.answeredEdition;
        delete answers.threads;
        Object.assign(answers, history);
      }
      scheduleAnswerSave();
    }};
  }

  async function selectFolder(prepare = () => {}, change = false) {
    if (selecting || connecting) return;
    selecting = true;
    try {
      // requestPermission / showDirectoryPicker はクリック直後の利用者操作権限を使う。
      if (!change && resume && handle) {
        const permission = await handle.requestPermission(mode);
        if (permission === 'granted') { await prepare(); return await connect(handle); }
        else {
          folderError = '保存の許可が必要です';
          localOnly();
          notify('フォルダの許可を得られませんでした。「保存を再開」で再試行できます。');
        }
      } else if (pickerAvailable()) {
        const dir = await window.showDirectoryPicker(mode);
        await prepare();
        return await connect(dir);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (['SecurityError', 'NotSupportedError'].includes(error.name)) pickerBlocked = true;
      if (error.name === 'SecurityError') resume = false;
      if (active) folderStatus();
      else {
        folderError = pickerBlocked ? '' : '保存先を選べませんでした';
        localOnly();
      }
      notify('フォルダを選べません。回答はコピーまたはJSON保存で渡せます。');
    } finally {
      selecting = false;
      if (active) folderStatus();
    }
  }

  /** 書き出せたときだけ完了時刻を返す。未接続なら操作権限があるうちに選択画面を開く。 */
  async function saveNow(prepare) {
    if (connecting) return;
    const finishInput = async () => { await prepare(); flushLocal(); };
    if (!active) return selectFolder(finishInput);
    await finishInput();
    if (!active || connecting) return;
    clearTimeout(timer);
    pending = true;
    folderStatus();
    return writeFolder();
  }

  // 選択や照合の途中には、以前のフォルダの印で画面を切り替えない。
  const connectedFolder = () => !selecting && !connecting && pickerAvailable() ? active?.dir ?? null : null;
  const pendingSave = () => pending || writing;

  /** 端末の下書きとこのフォルダの回答が保存されたときだけ true。端末保存の失敗は呼び出し元で欄に表示する。 */
  async function flushForReload(dir) {
    if (dir !== connectedFolder()) return false;
    flushLocal();
    if (pending) {
      clearTimeout(timer);
      await writeFolder();
    }
    await queue;
    if (writeFailure) throw Error('保存先への書き込みに失敗しました。' + writeFailure.message, {cause: 'folder'});
    // フォルダを待つ間にも入力できる。直近の下書きのトランザクション完了までページを保つ。
    for (;;) {
      flushView();
      const latest = viewWrite;
      const saved = await latest;
      if (viewDirty || latest !== viewWrite) continue;
      if (!saved) { viewDirty = true; throw Error('この端末に下書きを保存できません。空き容量を確認して、もう一度「更新」を押してください。'); }
      return dir === connectedFolder() && !pendingSave();
    }
  }

  async function init() {
    try { db = await openDatabase(); } catch { db = null; }
    let saved, savedView, localView;
    if (db) {
      try { saved = await transaction(db, 'drafts', os => os.get(key)); }
      catch { db = null; }
    }
    const local = readJournal();
    const fromDB = id => transaction(db, 'drafts', os => os.get(id));
    const fromJournal = id => JSON.parse(localStorage.getItem(id));
    async function readView(read, id) {
      const value=await read(id);
      return value?.tabKey && value.tabKey!==id ? await read(value.tabKey) : value;
    }
    async function latestView(id) {
      try { savedView=db && await readView(fromDB,id); } catch { savedView=null; }
      try { localView=await readView(fromJournal,id); } catch { localView=null; }
      return localView && (!savedView || localView.stamp>savedView.stamp) ? localView : savedView;
    }
    const view = await latestView(tabKey) ?? (tabKey!==viewKey ? await latestView(viewKey) : null);
    if (view?.workspace) { store.workspace = view.workspace; viewStamp = view.stamp; }
    let recoveryError = false;
    const latest = latestAnswer(local, saved);
    if (latest) {
      try {
        const pack = completePack(model, latest, saved?.media);
        Object.assign(store, pack);
        expectedCopy = {stamp: latest.stamp, writer: latest.writer};
        databaseCopy = saved && {stamp: saved.stamp, writer: saved.writer};
        knownMedia = saved?.media ?? {};
        tick = latest.stamp;
        // フォルダ未接続でも、読み取れた旧回答を端末に一度保存して移行を確定する。
        if (!Object.hasOwn(latest.answers, 'approvedSections')) { remember(); flushAnswers(); }
      } catch (error) {
        recoveryError = true;
        notify('端末の回答を復元できません。' + error.message);
      }
    }
    if (db && !recoveryError) {
      try { handle = await transaction(db, 'folders', os => os.get(key)); } catch { /* 次回のフォルダ選択で再接続できる。 */ }
    }
    if (handle) {
      try {
        if (await handle.queryPermission(mode) === 'granted') return await connect(handle);
      } catch { /* 読み取りが制限された環境でも、クリックで再要求できる場合がある。 */ }
      resume = typeof handle.requestPermission === 'function';
    }
    localOnly();
  }

  return Object.assign(store, {init, edited, fillRecommendations, viewEdited, selectFolder, saveNow, connect, snapshot, connectedFolder, pendingSave, flushForReload});
}
