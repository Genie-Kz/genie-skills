export const DEFER = '保留';
export const OTHER = 'その他';
export const optionLabel = option => typeof option === 'string' ? option : option.label;
export const MAX_TEXT = 4000;
export const MAX_PINS = 100;
export const isRange = mark => Object.hasOwn(mark, 'w');
export const markName = mark => (isRange(mark) ? '範囲' : 'ピン') + mark.number;
export const fraction = value => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;

const line = str => str.trim().replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ／ ');
const record = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const fields = (o, keys) => record(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const everyEntry = (o, test) => record(o) && Object.entries(o).every(([key, value]) => test(key, value));
const text = v => typeof v === 'string' && v.length <= MAX_TEXT;
const coord = n => Number.isFinite(n) && n >= 0 && n <= 1;
export const pngData = s => typeof s === 'string' && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(s);
const fileFor = id => 'images/' + id + '.png';
const markedFile = id => 'images/marks/' + id + '.png';
export const WHOLE = '全体';
const inlinePattern = () => /!\[(U-\d+)\]/g;
export const inlineRefs = body => Array.from(body.matchAll(inlinePattern()), m => m[1]);
/** 画像名はUnicodeのコードポイントで40文字まで。改行は空白にし、空文字を「名前なし」として保存する。 */
export function normalizeImageName(value) {
  if (typeof value !== 'string') throw Error('画像の名前を確認してください');
  const singleLine = value.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ').trim();
  return Array.from(singleLine).slice(0, 40).join('').trimEnd();
}

/** 以前の下書きにあるPNG文字列も、仮番号に対応する名前と画像データとして読む。 */
export function draftImage(draft, id) {
  const image = draft?.images[id];
  return typeof image === 'string' ? {dataUrl: image, name: ''} : image;
}

/** 空欄と空白だけの入力は同じと扱う。既存の文章を消す操作は変更に含める。 */
export function draftTextChanged(value, original = '') {
  return typeof value === 'string' && value !== original && Boolean(value.trim() || original.trim());
}

function formImagesChanged(draft, body, savedLoose, attachments, loose = draft.attachments ?? savedLoose) {
  const inline = inlineRefs(body);
  const looseIds = loose.filter(id => !inline.includes(id));
  if (looseIds.length !== savedLoose.length || looseIds.some((id, i) => id !== savedLoose[i])) return true;
  return [...looseIds, ...inline].some(id => Object.hasOwn(draft.images ?? {}, id)
    || (Object.hasOwn(draft.renames ?? {}, id) && draft.renames[id] !== attachments[id]?.name));
}

/** 再び編集でき、保存済みの回答と内容が異なる最初の依頼・セクションを示す。該当しなければ空文字。 */
export function formDraftLabel(workspace, answers) {
  for (const [id, draft] of Object.entries(workspace.requestDrafts ?? {})) {
    const saved = answers.requests.find(request => request.id === id);
    if (!draft || !saved) continue;
    const inline = inlineRefs(saved.text);
    const loose = saved.attachments.filter(image => !inline.includes(image));
    if (draftTextChanged(draft.text, saved.text) || (draft.target !== undefined && draft.target !== saved.target)
        || formImagesChanged(draft, draft.text ?? saved.text, loose, answers.attachments)) {
      const words = Array.from(line(saved.text.replace(inlinePattern(), '（画像）')));
      const excerpt = words.length > 20 ? words.slice(0, 20).join('') + '…' : words.join('');
      return '依頼「' + excerpt + '」';
    }
  }

  for (const [id, draft] of Object.entries(workspace.sectionDrafts ?? {})) {
    const saved = answers.userSections.find(section => section.id === id);
    if (!draft || (!saved && id !== 'new')) continue;
    // 公開済みのセクションの末尾画像は確定時に回答から引き継ぐ。本文欄を開くだけでは画像は外れない。
    const body = saved?.body ?? '';
    const inline = inlineRefs(body);
    const loose = (saved?.attachments ?? []).filter(image => !inline.includes(image));
    if (draftTextChanged(draft.title, saved?.title) || draftTextChanged(draft.text, body)
        || formImagesChanged(draft, draft.text ?? body, loose, answers.attachments, saved ? loose : draft.attachments)) {
      return saved ? 'セクション「' + saved.title + '」' : '新しいセクション';
    }
  }
  return '';
}

const serial = id => Number(id.slice(2));
const numbered = (prefix, number) => prefix + '-' + String(number).padStart(2, '0');
const isNumbered = (id, prefix) => typeof id === 'string' && id.startsWith(prefix + '-')
  && Number.isSafeInteger(serial(id)) && serial(id) > 0 && id === numbered(prefix, serial(id));
const generalAddress = 'sections:general';
const storedAddress = key => key === WHOLE ? generalAddress : key;
const printedAddress = key => key === generalAddress ? WHOLE : key;
export const validReplyKey = key => typeof key === 'string' && (key === WHOLE || /^[A-Za-z][\w:-]*(?:　(?:(?:ピン|範囲)[1-9]\d*|[A-Za-z][\w-]*))?$/.test(key))
  && !Object.hasOwn(Object.prototype, key);
const lastNumber = ids => ids.reduce((last, id) => Math.max(last, serial(id)), 0);
const validCounter = n => Number.isSafeInteger(n) && n >= 0;

function validGroup(g) {
  if (!fields(g, ['next','items']) || !Number.isSafeInteger(g.next) || g.next < 1
      || !Array.isArray(g.items) || g.items.length > MAX_PINS) return false;
  const numbers = new Set();
  return g.items.every(p => {
    if (!record(p) || !Number.isSafeInteger(p.number) || p.number < 1 || p.number >= g.next
        || numbers.has(p.number) || !coord(p.x) || !coord(p.y) || !text(p.comment)) return false;
    numbers.add(p.number);
    if (!isRange(p)) return fields(p, ['number','x','y','comment']);
    return fields(p, ['number','x','y','w','h','comment']) && coord(p.w) && coord(p.h)
      && p.w > 0 && p.h > 0 && p.x + p.w <= 1.0001 && p.y + p.h <= 1.0001;
  });
}

/** 比較は JSON のキー順に依存しない。配列内の要素の順序は保持する。 */
export function signature(value) {
  return JSON.stringify(value, (_, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

const canWriteOther = d => !d.items && d.other !== false;

/** 原稿順の選択肢に排他項目・自由記述・保留を加える。元からある「その他」は同じ行にまとめる。 */
export function decisionOptions(d) {
  const options = d.options.map(option => typeof option === 'string' ? {label: option} : option);
  const choices = canWriteOther(d) ? options.filter(option => option.label !== OTHER) : [...options];
  if (d.none) choices.push({label: d.none, note: 'ほかの選択肢と一緒には選べません。'});
  if (canWriteOther(d)) choices.push(options.find(option => option.label === OTHER) ?? {label: OTHER});
  choices.push({label: DEFER});
  return choices;
}

/** 横並びの候補を原稿だけで判定する。自動で足す選択肢を含めた実幅は表示時に測る。 */
export function compactDecision(d) {
  return !d.multiple && !d.items && d.options.length <= 3
    && d.options.every(o => [...optionLabel(o)].length <= 10 && !o.note?.trim());
}

export function hasSelection(answer) {
  const choice = answer?.choice;
  if (Array.isArray(choice)) return choice.length > 0;
  if (record(choice)) return Object.keys(choice).length > 0;
  return choice != null;
}

const pendingOther = answer => answer?.otherText !== undefined && !answer.otherText.trim();
const itemCount = (d, answer) => d.items.filter(item => {
  const choice = answer?.choice?.[item.id];
  return choice != null && choice !== DEFER;
}).length;
function itemProgress(d, answer, prose = false) {
  const chosen = itemCount(d, answer), total = d.items.length;
  const pending = d.items.filter(item => answer?.choice?.[item.id] === DEFER).length;
  const count = prose ? `${total}件中${chosen}件` : `${chosen}/${total}件`;
  return count + (pending ? '・保留 ' + pending : '');
}

/** 保留が一つでもある表は、その判断全体を保留として一度だけ数える。 */
export function decisionDeferred(answer) {
  const choice = answer?.choice;
  return choice === DEFER || (choice != null && typeof choice === 'object' && Object.values(choice).includes(DEFER));
}

/** 表は保留のない全項目に回答し、自由記述は空白以外を入力した時点で判断済みになる。 */
export function decisionAnswered(d, answer) {
  if (decisionDeferred(answer)) return false;
  if (d?.items) return itemCount(d, answer) === d.items.length;
  return !record(answer?.choice) && hasSelection(answer) && !pendingOther(answer);
}

/** 入力を始めた「その他」と既に選んだ組み合わせは、一括入力でも利用者の選択を保つ。 */
export function canFillDecision(d, answer) {
  return d.items ? d.items.some(item => item.recommended != null && answer?.choice?.[item.id] == null)
    : d.recommended != null && !hasSelection(answer);
}

/** 上限に達したら未選択の行を止める。選択済みの行は取り消せる。 */
export function atChoiceLimit(d, choice, label) {
  return d.multiple && Array.isArray(choice) && choice.length >= (d.max ?? Infinity) && !choice.includes(label);
}

/** 指定の判断だけを書き換える。最後のチェックを外し、補足も空なら回答そのものを取り除く。 */
export function setDecisionChoice(a, d, label, {itemId, checked = true} = {}) {
  const options = decisionOptions(d).map(optionLabel);
  if (!options.includes(label)) throw Error('選択肢を確認してください');
  const answer = a.decisions[d.id] ?? {choice: null, comment: ''};
  if (d.items) {
    if (!d.items.some(item => item.id === itemId)) throw Error('判定する項目を確認してください');
    answer.choice = {...answer.choice, [itemId]: label};
  } else if (d.multiple) {
    const previous = answer.choice ?? [];
    if (checked && atChoiceLimit(d, previous, label)) return;
    const exclusive = value => value === DEFER || value === d.none;
    const selected = new Set(previous);
    if (!checked) selected.delete(label);
    else if (exclusive(label)) { selected.clear(); selected.add(label); }
    else { selected.delete(DEFER); selected.delete(d.none); selected.add(label); }
    answer.choice = options.filter(value => selected.has(value));
  } else {
    answer.choice = label;
  }

  const hasOther = canWriteOther(d) && (d.multiple ? answer.choice.includes(OTHER) : answer.choice === OTHER);
  if (hasOther) answer.otherText ??= '';
  else delete answer.otherText;
  if (hasSelection(answer) || answer.comment.trim()) a.decisions[d.id] = answer;
  else delete a.decisions[d.id];
}

/** 選択中の「その他」の入力をそのまま保存する。空欄のままでも再読み込み後に続きが書ける。 */
export function setOtherText(answer, value) {
  if (!answer || !(answer.choice === OTHER || (Array.isArray(answer.choice) && answer.choice.includes(OTHER))) || !text(value)) {
    throw Error('その他の選択と入力内容を確認してください');
  }
  answer.otherText = value;
}

function validDecisionAnswer(d, answer) {
  if (!d || !record(answer) || !text(answer.comment)) return false;
  const hasText = Object.hasOwn(answer, 'otherText');
  if (!fields(answer, hasText ? ['choice','comment','otherText'] : ['choice','comment'])) return false;
  const options = d.options.map(optionLabel);
  const {choice} = answer;
  if (choice === null) return !hasText;
  if (d.items) {
    return !hasText && everyEntry(choice, (id, value) => d.items.some(item => item.id === id)
      && (options.includes(value) || value === DEFER));
  }
  const values = d.multiple ? choice : [choice];
  if (!Array.isArray(values) || new Set(values).size !== values.length) return false;
  if (d.multiple && (values.length > (d.max ?? Infinity)
      || (values.length > 1 && values.some(v => v === DEFER || v === d.none)))) return false;
  if (!values.every(v => typeof v === 'string' && (options.includes(v) || v === DEFER || v === d.none || (canWriteOther(d) && v === OTHER)))) return false;
  if (hasText) return canWriteOther(d) && values.includes(OTHER) && text(answer.otherText);
  return !values.includes(OTHER) || options.includes(OTHER);
}

/** セクションまで片付けた原稿では文書全体を渡す。配列を渡す従来の呼び出しも判断自身の settled を尊重する。 */
function openDecisions(definitions) {
  if (Array.isArray(definitions)) return definitions.filter(d => !d.settled);
  const closed = new Set(definitions.sections.filter(s => s.settled).map(s => s.id));
  return definitions.decisions.filter(d => !d.settled && !closed.has(d.section));
}

/** chosen は未確定の問いのうち回答した数。total は確定後も保存する全回答の件数。 */
export function counts(a, definitions) {
  const decisions = Object.values(a.decisions);
  const pins = Object.values(a.pins).reduce((sum, group) => sum + group.items.length, 0);
  const other = ['photos','rows','mocks','sections','attachments','approvedSections'].reduce((sum, key) => sum + Object.keys(a[key]).length, 0);
  const open = definitions && openDecisions(definitions);
  const deferred = (open ? open.map(d => a.decisions[d.id]) : decisions).filter(decisionDeferred).length;
  const chosen = open ? open.filter(d => decisionAnswered(d, a.decisions[d.id])).length
    : decisions.filter(answer => decisionAnswered(undefined, answer)).length;
  const followups = Object.values(a.threads ?? {}).reduce((sum, history) => sum + history.filter(item => item.comment.trim()).length, 0);
  return {chosen, deferred, total: decisions.length + pins + other + a.requests.length + a.userSections.length + Object.keys(a.itemComments ?? {}).length + followups};
}

/** 一括入力した判断の数と取り消し操作を返す。取り消しは、この操作で選んだ値だけを元に戻す。 */
export function fillRecommended(a, definitions) {
  const changes = [];
  for (const d of openDecisions(definitions)) {
    const previous = a.decisions[d.id];
    if (!canFillDecision(d, previous)) continue;
    const addedItems = d.items?.filter(item => previous?.choice?.[item.id] == null && item.recommended != null);
    const choice = addedItems
      ? {...previous?.choice, ...Object.fromEntries(addedItems.map(item => [item.id, item.recommended]))}
      : structuredClone(d.recommended);
    const answer = {choice, comment: previous?.comment ?? ''};
    if (canWriteOther(d) && (d.multiple ? choice.includes(OTHER) : choice === OTHER)) answer.otherText = '';
    a.decisions[d.id] = answer;
    changes.push({id: d.id, previous, addedItems, filled: structuredClone(answer)});
  }

  function undo() {
    for (const {id, previous, addedItems, filled} of changes) {
      const current = a.decisions[id];
      if (!current) continue;
      if (addedItems && record(current.choice)) {
        for (const item of addedItems) {
          if (current.choice[item.id] === item.recommended) delete current.choice[item.id];
        }
        if (!hasSelection(current)) current.choice = previous?.choice ?? null;
      } else {
        if (signature(current.choice) !== signature(filled.choice) || current.otherText !== filled.otherText) continue;
        current.choice = previous?.choice ?? null;
        delete current.otherText;
      }
      if (!previous && !hasSelection(current) && !current.comment.trim()) delete a.decisions[id];
    }
    changes.length = 0;
  }
  return {count: changes.length, undo};
}

const quoted = value => '「' + line(value) + '」';
const quotedList = values => values.map(quoted).join('');
function displayChoice(value, answer, quote = false) {
  if (value === OTHER && answer?.otherText !== undefined) {
    return pendingOther(answer) ? 'その他（内容が未入力）' : 'その他' + quoted(answer.otherText);
  }
  return quote ? quoted(value) : line(value);
}

/** 判断一覧に出す短い回答。表は回答した項目の件数、空の自由記述は未回答と表示する。 */
export function decisionSummary(d, answer) {
  if (d.items) return itemProgress(d, answer);
  if (!hasSelection(answer)) return '未回答';
  const values = d.multiple ? answer.choice : [answer.choice];
  const current = values.map(v => displayChoice(v, answer)).join('、');
  return pendingOther(answer) ? '未回答・' + current : current;
}

function decisionText(d, answer) {
  if (d.multiple) {
    const rec = quotedList(d.recommended);
    if (!hasSelection(answer)) return `未回答（推奨は${rec}）`;
    const chosen = answer.choice.map(v => displayChoice(v, answer, true)).join('');
    if (pendingOther(answer)) return `未回答（入力中の選択は${chosen}）（推奨は${rec}）`;
    const same = answer.otherText === undefined && answer.choice.length === d.recommended.length
      && d.recommended.every(value => answer.choice.includes(value));
    return same ? '推奨どおり' + chosen : `${chosen}（推奨は${rec}）`;
  }
  if (!hasSelection(answer)) return '未回答';
  if (pendingOther(answer)) return '未回答（その他の内容が未入力）';
  if (answer.otherText !== undefined) return displayChoice(OTHER, answer);
  return answer.choice === d.recommended ? '推奨どおり' + quoted(answer.choice) : line(answer.choice);
}

/** 表示する判断は原稿順。欄・印・添付なども、それぞれ同じ宛先どうしを比べて差の総数に含める。 */
export function answerDifferences(doc, local, disk) {
  const a = local.answers, b = disk.answers;
  const decisions = doc.decisions.filter(d => signature(a.decisions[d.id]) !== signature(b.decisions[d.id])).map(d => {
    const commentChanged = (a.decisions[d.id]?.comment ?? '') !== (b.decisions[d.id]?.comment ?? '');
    function describe(answer) {
      const value = hasSelection(answer) ? '「' + settledAnswer(d, answer) + '」' : '未回答';
      return commentChanged && answer?.comment ? value + '（' + line(answer.comment) + '）' : value;
    }
    return {id: d.id, local: describe(a.decisions[d.id]), disk: describe(b.decisions[d.id])};
  });
  function changedKeys(one = {}, two = {}) {
    return [...new Set([...Object.keys(one), ...Object.keys(two)])].filter(key => one[key] !== two[key] && signature(one[key]) !== signature(two[key]));
  }
  const byId = items => Object.fromEntries(items.map(item => [item.id, item]));
  const pins = groups => Object.fromEntries(Object.entries(groups).flatMap(([key, group]) =>
    group.items.map(item => [markKey(key, item), item])));
  let total = decisions.length;
  for (const kind of ['sections', 'rows', 'mocks', 'photos', 'approvedSections', 'itemComments', 'threads', 'archived']) {
    total += changedKeys(a[kind], b[kind]).length;
  }
  for (const kind of ['requests', 'userSections']) total += changedKeys(byId(a[kind]), byId(b[kind])).length;
  total += changedKeys(pins(a.pins), pins(b.pins)).length;
  total += new Set([...changedKeys(a.attachments, b.attachments), ...changedKeys(local.media, disk.media)]).size;
  return {decisions, total};
}

/** read は空の手元に既存回答を取り込む場合。ask の結果をコミットするには明示的な選択が必要。 */
export function connectionChoice(local, disk) {
  if (!disk) return 'write';
  // 最後のコメントを消した回答にも編集した回の番号が残る。空の端末と取り違えて古い内容を復活させない。
  const hasHistory = a => counts(a).total || a.answeredEdition || a.lastRequestNumber || a.lastAttachmentNumber || a.lastSectionNumber;
  if (!hasHistory(local.answers)) return 'read';
  if (!hasHistory(disk.answers)) return 'write';
  const content = pack => {
    const {answeredEdition, ...answers} = pack.answers;
    return signature({...pack, answers});
  };
  if (content(local) !== content(disk)) return 'ask';
  return (disk.answers.answeredEdition ?? 0) > (local.answers.answeredEdition ?? 0) ? 'read' : 'same';
}

/** 追加した画像の U 番号を返す。削除済みファイルと同名にならないよう、最終番号は回答とともに保存する。 */
export function addAttachment(a, media, section, data, name = '') {
  const normalized = normalizeImageName(name);
  if (!Number.isSafeInteger(a.lastAttachmentNumber + 1)) throw Error('追加画像の番号を使い切りました');
  const id = numbered('U', ++a.lastAttachmentNumber);
  a.attachments[id] = {section, file: fileFor(id), comment: '', name: normalized};
  media[id] = data;
  return id;
}

/** フォルダ用の JSON には相対パスを、単独で渡す JSON には同じ項目に画像本体も載せる。 */
export function portableAnswers({answers, media}) {
  const copy = structuredClone(answers);
  for (const [id, attachment] of Object.entries(copy.attachments)) {
    if (!pngData(media[id])) throw Error(id + ' の画像を読み込めません');
    if (!Object.hasOwn(attachment, 'name')) attachment.name = '';
    attachment.dataUrl = media[id];
  }
  return copy;
}

// 戻す操作と、明示的に削除した対象の後片付けで使う。画像の削除では、その画像の印も対象になる。
function forgetFiled(a, id, includeMarks = false) {
  if (!a.archived) return;
  const remaining = Object.entries(a.archived).filter(([key]) => key !== id && !(includeMarks && key.startsWith(id + '　')));
  if (remaining.length === Object.keys(a.archived).length) return;
  if (remaining.length) a.archived = Object.fromEntries(remaining);
  else delete a.archived;
}

/** 追加したセクションとそのセクションへのコメントを削除する。依頼・画像は全体へ移し、採番履歴を保つ。 */
export function removeUserSection(answers, id) {
  if (!answers.userSections.some(section => section.id === id)) return;
  answers.userSections = answers.userSections.filter(section => section.id !== id);
  delete answers.sections[id];
  forgetFiled(answers, id);
  forgetFiled(answers, 'sections:' + id);
  if (answers.threads) {
    delete answers.threads[id];
    delete answers.threads['sections:' + id];
  }
  answers.requests = answers.requests.map(request => request.target === id ? {...request, target: WHOLE} : request);
  for (const image of Object.values(answers.attachments)) {
    if (image.section === id) image.section = 'general';
  }
}

/** 画像をすべての依頼・印・端末内画像から取り除く。保存済みの PNG と採番履歴は保持する。 */
export function removeAttachment(a, media, id) {
  if (!Object.hasOwn(a.attachments, id)) return;
  delete a.attachments[id];
  delete a.pins[id];
  delete media[id];
  forgetFiled(a, id, true);
  const strip = body => body.replace(inlinePattern(), (token, key) => key === id ? '' : token);
  for (const [key, history] of Object.entries(a.threads ?? {})) {
    if (key === id || key.startsWith(id + '　')) delete a.threads[key];
    else for (const item of history) item.comment = strip(item.comment);
  }
  const detach = ids => ids.filter(key => key !== id);
  a.requests = a.requests.map(r => {
    const value = strip(r.text);
    return {...r, text: value.trim() ? value : '（添付画像を削除しました）', attachments: detach(r.attachments)};
  });
  a.userSections = a.userSections.map(s => ({...s, body: strip(s.body), attachments: detach(s.attachments)}));
  for (const kind of ['rows','mocks','sections','photos','itemComments']) {
    for (const [key, body] of Object.entries(a[kind] ?? {})) {
      const value = strip(body);
      if (value.trim()) a[kind][key] = value; else delete a[kind][key];
    }
  }
  if (a.itemComments && !Object.keys(a.itemComments).length) delete a.itemComments;
  for (const [key, decision] of Object.entries(a.decisions)) {
    decision.comment = strip(decision.comment);
    if (!hasSelection(decision) && !decision.comment.trim()) delete a.decisions[key];
  }
  for (const image of Object.values(a.attachments)) image.comment = strip(image.comment);
  for (const group of Object.values(a.pins)) for (const mark of group.items) mark.comment = strip(mark.comment);
}

/** 依頼を削除する。共用できる添付画像と、発行済みの R 番号は保持する。 */
export function removeRequest(a, id) {
  a.requests = a.requests.filter(r => r.id !== id);
  forgetFiled(a, id);
  if (a.threads) delete a.threads[id];
}

/** answers.md の行頭と原稿の replies が共有する宛先。同名がある場合だけ種類を添える。 */
export function replyAddresses(doc) {
  const owners = new Map();
  function add(kind, id) {
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(kind);
  }
  for (const section of doc.sections) {
    add('sections', section.id);
    for (const row of section.rows) {
      add('rows', row.id);
      for (const id of row.mocks) add('mocks', id);
    }
  }
  for (const d of doc.decisions) add('decisions', d.id);
  for (const id of Object.keys(doc.figures)) add('photos', id);
  for (const issue of doc.issues) if (issue.file) add('photos', issue.id);

  function key(kind, id) {
    // 既存の行・図にも general という ID を使えるため、全体コメントの宛先だけを修飾する。
    if (kind === 'sections' && id === 'general') return generalAddress;
    if (kind === 'itemComments') {
      const [decision, item] = id.split('　');
      return key('decisions', decision) + '　' + item;
    }
    if (kind === 'sectionNotes') return 'sections:' + id;
    const reserved = /^R-\d+$/.test(id) ? 'requests' : /^U-\d+$/.test(id) ? 'attachments' : /^S-\d+$/.test(id) ? 'sections' : null;
    if (reserved) return reserved === kind ? id : kind + ':' + id;
    return owners.get(id)?.size > 1 ? kind + ':' + id : id;
  }
  function targets(a = {}) {
    const known = new Set([generalAddress, WHOLE]);
    for (const d of doc.decisions) {
      for (const item of d.items ?? []) known.add(key('itemComments', d.id + '　' + item.id));
    }
    for (const [id, kinds] of owners) for (const kind of kinds) known.add(key(kind, id));
    for (const {id} of [...(a.requests ?? []), ...(a.userSections ?? [])]) known.add(id);
    for (const {id} of a.userSections ?? []) {
      if (a.sections?.[id]) known.add(key('sectionNotes', id));
    }
    for (const id of Object.keys(a.attachments ?? {})) known.add(id);
    for (const [id, group] of Object.entries(a.pins ?? {})) {
      const image = key(Object.hasOwn(a.attachments ?? {}, id) ? 'attachments' : 'photos', id);
      for (const mark of group.items ?? []) known.add(markKey(image, mark));
    }
    return known;
  }
  return {key, targets};
}

/** 印の行頭は従来どおり「図ID　ピン1」または「図ID　範囲2」。空白も含めて一つのキーになる。 */
export const markKey = (image, mark) => image + '　' + markName(mark);

export function settledAnswer(d, answer) {
  if (!d.items) return decisionSummary(d, answer);
  return d.items.map(item => line(item.label) + '＝' + (answer?.choice?.[item.id] ?? '未回答')).join('、');
}

/** 資料内で選んだ答えを返す。補足だけの回答と、本文が空の「その他」だけの回答は undefined。 */
export function recordedDecision(d, answer) {
  if (!hasSelection(answer)) return undefined;
  const hasOtherChoices = Array.isArray(answer.choice) && answer.choice.some(value => value !== OTHER);
  if (pendingOther(answer) && !hasOtherChoices) return undefined;
  return settledAnswer(d, answer);
}

export function answerModel(doc) {
  const addresses = replyAddresses(doc);
  const sectionMap = new Map(doc.sections.map(s => [s.id, s]));
  const decisions = new Map(doc.decisions.map(d => [d.id, d]));
  const activeDecisions = openDecisions(doc);
  const decisionsBySection = new Map(doc.sections.map(s => [s.id, []]));
  for (const d of activeDecisions) decisionsBySection.get(d.section)?.push(d);
  // 決定事項へ移った判断も、作者の章を手動で了承できるかの判定には含める。
  const sectionsWithDecisions = new Set(doc.decisions.map(d => d.section));
  const canApproveSection = id => sectionMap.has(id) && !sectionsWithDecisions.has(id);
  const issues = new Map(doc.issues.map(i => [i.id, i]));
  const rows = new Map(), mocks = new Map(), sectionFigures = new Map();
  for (const section of doc.sections) {
    const figures = new Set();
    sectionFigures.set(section.id, figures);
    for (const row of section.rows) {
      rows.set(row.id, {section, row});
      for (const id of row.mocks) mocks.set(id, {section, row});
      for (const id of row.photos) figures.add(id);
    }
  }
  const itemKeys = new Set();
  for (const d of doc.decisions) {
    for (const item of d.items ?? []) {
      itemKeys.add(d.id + '　' + item.id);
      if (item.figure) sectionFigures.get(d.section).add(item.figure);
    }
  }
  const validItemComment = (key, value) => itemKeys.has(key) && text(value);

  /** 章の本文と判断項目で共用する図も一度だけ返す。 */
  function figuresInSection(id) {
    return [...(sectionFigures.get(id) ?? [])];
  }

  // 利用者が回答した時点の返事を残す。次の原稿が同じキーに新しい返事を書いても、前の追記を元の返事に結び付ける。
  function threads(a, key) {
    key = storedAddress(key);
    const history = a.threads?.[key] ?? [];
    // 過去の全体コメント・追記・完了は同じ保存キーに残し、原稿の新旧どちらの宛先も同じ会話へ合流させる。
    const aliases = key === generalAddress ? [WHOLE, generalAddress] : [key];
    let records = history;
    for (const alias of aliases) {
      const edition = doc.replyEditions?.[alias];
      if (Number.isSafeInteger(edition) && !records.some(item => item.edition === edition)) {
        records = [...records, {edition, reply: doc.replies[alias], comment: ''}];
      }
    }
    return records === history ? history : records.sort((a, b) => a.edition - b.edition);
  }

  function recordEdition(a) {
    if (!doc.built?.number) return;
    a.answeredEdition = doc.built.number;
    const keys = Object.keys(doc.replyEditions ?? {});
    if (!keys.length) return;
    const targets = addresses.targets(a);
    for (const key of keys) {
      if (targets.has(key)) (a.threads ??= {})[storedAddress(key)] = threads(a, key);
    }
  }

  /** 同じ項目を再度完了にしても最初に完了した回を保つ。戻すと表示状態だけを取り除く。 */
  function setArchived(a, key, archived) {
    key = storedAddress(key);
    if (!validReplyKey(key) || !addresses.targets(a).has(key)) throw Error('完了にする項目を確認してください');
    if (!archived) return forgetFiled(a, key);
    const edition = doc.built?.number;
    if (!Number.isSafeInteger(edition) || edition < 1) throw Error('完了した回を確認してください');
    if (!a.archived?.[key]) a.archived = {...a.archived, [key]: {at: edition}};
  }

  function resolvedLabel(key) {
    key = storedAddress(key);
    const at = doc.resolvedEditions?.[printedAddress(key)] ?? doc.resolvedEditions?.[key];
    return Number.isSafeInteger(at) ? '✓ 対応済み（第' + at + '回）' : '';
  }

  function settledSummary(a, d) {
    const answer = a.decisions[d.id];
    const recorded = recordedDecision(d, answer) ?? doc.settledAnswers?.[d.id];
    if (recorded !== undefined) return recorded;
    if (d.decided) return line(d.decided.answer) + '（' + line(d.decided.via ?? 'チャット') + 'で決定）';
    return settledAnswer(d, answer);
  }

  function followUp(a, key, edition, comment) {
    key = storedAddress(key);
    const history = threads(a, key);
    if (!text(comment) || !history.some(item => item.edition === edition)) throw Error('返事の回と追記の文を確認してください');
    (a.threads ??= {})[key] = history.map(item => item.edition === edition ? {...item, comment} : item);
  }

  /** 選択の有無とは独立して項目の補足を保存する。最後の補足を消すと従来の JSON の形に戻る。 */
  function setItemComment(a, id, value) {
    if (!validItemComment(id, value)) throw Error('判断項目のコメントを確認してください');
    if (value.trim()) (a.itemComments ??= {})[id] = value;
    else if (a.itemComments) {
      delete a.itemComments[id];
      if (!Object.keys(a.itemComments).length) delete a.itemComments;
    }
  }

  function empty() {
    return {
      documentId: doc.id, version: doc.version,
      decisions: {}, pins: {}, photos: {}, mocks: {}, rows: {}, sections: {}, approvedSections: {},
      attachments: {}, requests: [], userSections: [],
      lastSectionNumber: 0, lastRequestNumber: 0, lastAttachmentNumber: 0,
    };
  }

  /** 対象は判断を持たない作者のセクション。取消は了承だけを消し、そのセクションに書いた回答を保持する。 */
  function setSectionApproved(a, id, approved) {
    if (!canApproveSection(id) || typeof approved !== 'boolean') throw Error('セクションの了承を設定できません');
    if (approved) a.approvedSections[id] = true;
    else delete a.approvedSections[id];
  }

  const hasSection = (a, id) => sectionMap.has(id) || a.userSections.some(s => s.id === id);
  const validLinks = (ids, images) => Array.isArray(ids) && new Set(ids).size === ids.length
    && ids.every(id => isNumbered(id, 'U') && Object.hasOwn(images, id));
  const validRequest = (r, a) => fields(r, ['id','target','text','attachments']) && isNumbered(r.id, 'R')
    && (r.target === WHOLE || hasSection(a, r.target)) && text(r.text) && Boolean(r.text.trim()) && validLinks(r.attachments, a.attachments);

  /** 新規は R 番号を返す。編集は同じ番号を返し、入力不正時は本文・画像・採番履歴をすべて保持する。 */
  function saveRequest(a, media, {id, target, text: body, attachments}, images = []) {
    const index = id == null ? -1 : a.requests.findIndex(r => r.id === id);
    if (id != null && index < 0) throw Error('編集する依頼が見つかりません');
    const number = a.lastRequestNumber + 1;
    if (id == null && !Number.isSafeInteger(number)) throw Error('依頼の番号を使い切りました');
    const request = {id: id ?? numbered('R', number), target, text: body, attachments};
    if (!validRequest(request, a)) throw Error('依頼の本文・対象・添付画像を確認してください');
    if (!images.every(pngData) || !Number.isSafeInteger(a.lastAttachmentNumber + images.length)) throw Error('追加する画像を確認してください');

    // 全項目が確定してから画像番号を振る。取消・入力エラーでは空の依頼や孤立した画像を作らない。
    const section = target === WHOLE ? 'general' : target;
    request.attachments = [...attachments, ...images.map(data => addAttachment(a, media, section, data))];
    if (index < 0) {
      a.lastRequestNumber = number;
      a.requests = [...a.requests, request];
    } else {
      a.requests = a.requests.map(r => r.id === id ? request : r);
    }
    return request.id;
  }

  /** JSON保存・過去の試作・フォルダから同じ検査を通す。対応しない回答は破棄せず、書き込みを止める。 */
  function unpack(input) {
    let a = structuredClone(input);
    // 追加の記録を先に検査し、従来の各世代の必須キーは従来どおり厳密に照合する。
    const metadata = {};
    if (Object.hasOwn(a, 'itemComments')) {
      if (!everyEntry(a.itemComments, validItemComment)) throw Error('判断項目のコメントを読み取れません');
      if (Object.keys(a.itemComments).length) metadata.itemComments = a.itemComments;
      delete a.itemComments;
    }
    if (Object.hasOwn(a, 'answeredEdition')) {
      if (!Number.isSafeInteger(a.answeredEdition) || a.answeredEdition < 1) throw Error('回答した回の番号を確認してください');
      metadata.answeredEdition = a.answeredEdition;
      delete a.answeredEdition;
    }
    if (Object.hasOwn(a, 'archived')) {
      if (!everyEntry(a.archived, (key, value) => validReplyKey(key) && fields(value, ['at'])
          && Number.isSafeInteger(value.at) && value.at > 0)) throw Error('項目を完了した回の番号を確認してください');
      if (a.archived[WHOLE]) {
        const publicEntry = a.archived[WHOLE], oldEntry = a.archived[generalAddress];
        a.archived[generalAddress] = oldEntry && oldEntry.at < publicEntry.at ? oldEntry : publicEntry;
        delete a.archived[WHOLE];
      }
      if (Object.keys(a.archived).length) metadata.archived = a.archived;
      delete a.archived;
    }
    if (Object.hasOwn(a, 'threads')) {
      if (!everyEntry(a.threads, (key, history) => validReplyKey(key) && Array.isArray(history)
          && history.every((item, i) => fields(item, ['edition','reply','comment']) && Number.isSafeInteger(item.edition)
            && item.edition > (history[i - 1]?.edition ?? 0) && typeof item.reply === 'string' && item.reply.trim() && text(item.comment)))) {
        throw Error('返事と追記の記録を読み取れません');
      }
      if (a.threads[WHOLE]) {
        const editions = new Map((a.threads[generalAddress] ?? []).map(item => [item.edition, item]));
        for (const item of a.threads[WHOLE]) {
          const prior = editions.get(item.edition);
          if (prior && signature(prior) !== signature(item)) throw Error('全体への返事と追記の記録が一致しません');
          editions.set(item.edition, item);
        }
        a.threads[generalAddress] = [...editions.values()].sort((a, b) => a.edition - b.edition);
        delete a.threads[WHOLE];
      }
      metadata.threads = a.threads;
      delete a.threads;
    }
    if (doc.acceptLegacy && fields(a, ['version','decisions','pins','mocks','sections'])) a = {...empty(), ...a};
    const legacyKeys = ['documentId','version','decisions','pins','photos','mocks','rows','sections','general','attachments'];
    if (fields(a, legacyKeys) && text(a.general) && record(a.attachments)) {
      // v2 の全体画像は自由記述と同じ欄にあった。本文があれば、その画像も最初の依頼からたどれるようにする。
      const {general, ...original} = a;
      const images = Object.keys(a.attachments).filter(id => a.attachments[id]?.section === 'general');
      const requests = general.trim() ? [{id:'R-01', target:WHOLE, text:general, attachments:images}] : [];
      a = {...original, requests, lastRequestNumber: requests.length, lastAttachmentNumber: lastNumber(Object.keys(a.attachments))};
    }
    // 旧形式のキーがすべて揃った段階で次の形式へ進める。欠けた項目や未知のキーは移行で補わない。
    const currentKeys = Object.keys(empty());
    const v3Keys = currentKeys.filter(k => k !== 'approvedSections');
    const v21Keys = v3Keys.filter(k => !['userSections','lastSectionNumber'].includes(k));
    if (fields(a, v21Keys)) a = {...a, userSections: [], lastSectionNumber: 0};
    if (fields(a, v3Keys)) a = {...a, approvedSections: {}};
    if (!fields(a, currentKeys) || a.documentId !== doc.id || a.version !== doc.version) throw Error('資料ID・version または回答形式が一致しません');
    if (!Array.isArray(a.userSections) || !validCounter(a.lastSectionNumber) || !record(a.attachments)
        || !a.userSections.every(s => fields(s, ['id','title','body','attachments']) && isNumbered(s.id, 'S')
          && !sectionMap.has(s.id) && serial(s.id) <= a.lastSectionNumber && text(s.title) && s.title.trim()
          && text(s.body) && validLinks(s.attachments, a.attachments))
        || new Set(a.userSections.map(s => s.id)).size !== a.userSections.length) throw Error('追加したセクションを読み取れません');
    const media = {};
    const validImages = everyEntry(a.attachments, (id, attachment) => {
      if (!isNumbered(id, 'U') || !record(attachment)) return false;
      if (Object.hasOwn(attachment, 'dataUrl')) {
        if (!pngData(attachment.dataUrl)) return false;
        media[id] = attachment.dataUrl;
        delete attachment.dataUrl;
      }
      if (!Object.hasOwn(attachment, 'name')) attachment.name = '';
      attachment.name = normalizeImageName(attachment.name);
      return fields(attachment, ['section','file','comment','name']) && (hasSection(a, attachment.section) || attachment.section === 'general')
        && attachment.file === fileFor(id) && text(attachment.comment);
    });
    const isPhoto = id => Object.hasOwn(doc.figures, id) || Boolean(issues.get(id)?.file);
    const valid = validImages && validCounter(a.lastAttachmentNumber) && lastNumber(Object.keys(a.attachments)) <= a.lastAttachmentNumber
      && validCounter(a.lastRequestNumber) && Array.isArray(a.requests)
      && a.requests.every(r => validRequest(r, a) && serial(r.id) <= a.lastRequestNumber)
      && new Set(a.requests.map(r => r.id)).size === a.requests.length
      && everyEntry(a.decisions, (id, answer) => {
        const d = decisions.get(id);
        // 同じ問いを複数選択に広げた原稿でも、以前の原稿で選んだ1つを引き継ぐ。
        if (d?.multiple && typeof answer?.choice === 'string') answer.choice = [answer.choice];
        if (!validDecisionAnswer(d, answer)) return false;
        // 旧原稿に明記された「その他」を、新しい入力欄で続けて答えられるようにする。
        if (canWriteOther(d) && (answer.choice === OTHER || (Array.isArray(answer.choice) && answer.choice.includes(OTHER)))) {
          answer.otherText ??= '';
        }
        return true;
      })
      && everyEntry(a.pins, (id, g) => (isPhoto(id) || Object.hasOwn(a.attachments, id)) && validGroup(g))
      && everyEntry(a.photos, (id, v) => isPhoto(id) && text(v))
      && everyEntry(a.mocks, (id, v) => mocks.has(id) && text(v))
      && everyEntry(a.rows, (id, v) => rows.has(id) && text(v))
      && everyEntry(a.sections, (id, v) => (id === 'general' || hasSection(a,id)) && text(v))
      && everyEntry(a.approvedSections, (id, value) => canApproveSection(id) && value === true);
    if (!valid) throw Error('回答の項目・画像・座標を読み取れません');
    if (!metadata.answeredEdition && doc.built?.legacyAnsweredEdition && (counts(a).total || metadata.itemComments)) {
      metadata.answeredEdition = doc.built.legacyAnsweredEdition;
    }
    return {answers: Object.assign(a, metadata), media};
  }

  const sectionTitle = (id, a) => sectionMap.get(id)?.title ?? a?.userSections.find(s => s.id === id)?.title ?? WHOLE;
  const targetLabel = (id, a) => id === WHOLE || id === 'general' ? WHOLE : 'セクション「' + sectionTitle(id, a) + '」';

  /** 丸の状態とその読み上げ・表示用の文言を返す。判断一覧に転載した選択肢は所有するセクションで数える。 */
  function sectionProgress(a, id) {
    const own = decisionsBySection.get(id) ?? [];
    if (own.length) {
      const chosen = own.filter(d => decisionAnswered(d, a.decisions[d.id])).length;
      const held = own.filter(d => decisionDeferred(a.decisions[d.id]));
      if (held.length) return {state:'hold', label:`判断 ${chosen}/${own.length}・保留 ${held.length}`};
      if (chosen === own.length) return {state:'done', label:'判断済み・コメントのない行は了承'};
      if (chosen) return {state:'part', label:`判断 ${chosen}/${own.length}`};
    } else if (canApproveSection(id) && a.approvedSections[id] === true) {
      return {state:'done', label:'OK済み'};
    }

    const marked = key => a.photos[key]?.trim() || a.pins[key]?.items.length;
    const answeredRow = r => a.rows[r.id]?.trim() || r.mocks.some(key => a.mocks[key]?.trim());
    const any = own.some(d => hasSelection(a.decisions[d.id]) || a.decisions[d.id]?.comment.trim()
      || d.items?.some(item => a.itemComments?.[d.id + '　' + item.id]?.trim()))
      || a.sections[id]?.trim() || sectionMap.get(id)?.rows.some(answeredRow) || a.userSections.some(s => s.id === id)
      || figuresInSection(id).some(marked) || doc.issues.some(i => i.sections.includes(id) && marked(i.id))
      || Object.values(a.attachments).some(img => img.section === id)
      || (id === 'general' ? a.requests.length > 0 : a.requests.some(r => r.target === id));
    return any ? {state:'part', label:'記入あり'} : {state:'empty', label:'未回答'};
  }

  /** セクション一覧の丸に使う empty（空）、part（半円）、hold（黄色の点線丸）、done（青丸）のいずれかを返す。 */
  function sectionState(a, id) {
    return sectionProgress(a, id).state;
  }

  function filedTitle(a, key) {
    const [base, mark] = key.split('　'), id = base.split(':').at(-1);
    if (storedAddress(key) === generalAddress) return '全体へのコメント';
    if (mark && addresses.key('decisions', id) === base) {
      const item = decisions.get(id)?.items?.find(item => item.id === mark);
      if (item) return item.label;
    }
    if (isNumbered(id, 'S') && base === addresses.key('sectionNotes', id)) return sectionTitle(id, a) + 'へのコメント';
    if (addresses.key('rows', id) === base && rows.has(id)) return rows.get(id).row.title;
    if (addresses.key('mocks', id) === base && mocks.has(id)) return mocks.get(id).row.mockTitles?.[id] ?? mocks.get(id).row.title;
    if (addresses.key('decisions', id) === base && decisions.has(id)) return decisions.get(id).question;
    if (addresses.key('sections', id) === base && hasSection(a, id)) return sectionTitle(id, a);
    const request = a.requests.find(r => r.id === base);
    if (request) return targetLabel(request.target, a) + 'への依頼';
    const title = picture(a, id).title;
    return mark ? title + 'の' + mark : title;
  }

  /** 返事の元のページと画像を返す。手元に元の記入がない宛先は、返事の本文を一覧で読める。 */
  function replyLocation(a, rawKey) {
    const key = storedAddress(rawKey), [base, detail] = key.split('　'), id = base.split(':').at(-1);
    const matches = kind => addresses.key(kind, id) === base;
    if (key === generalAddress) return {key, page: 'general', label: '全体へのコメント'};
    const d = decisions.get(id);
    if (d && matches('decisions')) {
      const item = d.items?.find(item => item.id === detail);
      return {key, page: d.section, settled: d.settled, label: (item ? id + ' ' + item.label : id) + ' へのコメント'};
    }
    if (rows.has(id) && matches('rows')) return {key, page: rows.get(id).section.id, label: rows.get(id).row.title + ' へのコメント'};
    if (mocks.has(id) && matches('mocks')) return {key, page: mocks.get(id).section.id, label: filedTitle(a, key) + ' へのコメント'};
    if (((doc.figures[id] || issues.get(id)?.file) && matches('photos')) || (a.attachments[id] && matches('attachments'))) {
      const pic = picture(a, id);
      return {key, page: pic.sections[0] ?? 'general', image: id, label: pic.title + (detail ? ' ' + detail : ' へのコメント')};
    }
    const request = a.requests.find(r => r.id === key);
    if (request) return {key, page: 'general', owner: request.target, label: targetLabel(request.target, a) + 'への依頼'};
    if (hasSection(a, id) && (matches('sections') || matches('sectionNotes'))) {
      return {key, page: id, label: sectionTitle(id, a) + ' へのコメント'};
    }
    return {key, label: rawKey + ' へのコメント'};
  }

  function picture(a, id) {
    const attachment = a.attachments[id], issue = issues.get(id);
    if (attachment) return {title: attachment.name || attachment.comment || '追加画像 ' + id, file: attachment.file, sections: [attachment.section]};
    if (issue) return {issue:true,title: [issue.originalLabel, issue.summary].filter(Boolean).join(' '), file: issue.file, sections: issue.sections};
    const fig = doc.figures[id];
    const sections = doc.sections.filter(s => sectionFigures.get(s.id).has(id)).map(s => s.id);
    return {title: fig.title, file: fig.file, sections};
  }

  /** 資料順の answers.md を返す。copy は未保存でも渡せる文面、preview は画面用で管理番号とファイルパスを省く。 */
  function reviewDocument(a, {copy = false, preview = false} = {}) {
    const filed = new Map();
    const entries = new Map(), sharedFrom = new Map();
    const label = name => name ? '画像「' + name + '」' : '画像';
    const bodyLine = body => line(body.replace(inlinePattern(), (token, id) => {
      const name = a.attachments[id]?.name;
      if (preview) return label(name);
      return name ? `![${id}「${name}」]` : token;
    }));
    const files = ids => ids.map(id => {
      const {name, file} = a.attachments[id];
      return ' ／ ' + label(name) + (preview ? '' : ' ' + file);
    }).join('');
    const entry = (id, text) => {
      id = printedAddress(id);
      const prefix = preview ? id.replace(/^[URS]-\d+(?:　|$)/, '') : id;
      return prefix ? prefix + '　' + text : text;
    };
    function conversation(key) {
      return threads(a, key).flatMap(item => [
        '　返事（第' + item.edition + '回）' + quoted(item.reply),
        ...(item.comment.trim() ? ['　追記「' + bodyLine(item.comment) + '」'] : []),
      ]);
    }
    function append(owner, id, text, withReply = true, compact = text) {
      const group = a.archived?.[id] ? id : a.archived?.[owner] && isNumbered(owner, 'S') ? owner : null;
      const reply = withReply ? conversation(id) : [];
      const resolved = resolvedLabel(id);
      if (group) {
        if (!filed.has(group)) filed.set(group, []);
        const status = (resolved ? '　' + resolved : '') + '　完了';
        filed.get(group).push({id, owner, text: compact, lines: [entry(id, text + status), ...reply], reply});
        return;
      }
      if (!entries.has(owner)) entries.set(owner, []);
      // 確定したセクションの行頭には宛先がある。長い題名・座標・添付一覧の繰り返しを省く。
      const body = sectionMap.get(owner)?.settled ? compact : text;
      entries.get(owner).push(entry(id, body + (resolved ? '　' + resolved : '')), ...reply);
    }

    // 旧キットでは追加セクションとそのコメントが同じ S 番号を共有した。
    // 個別の完了記録・返事があるときだけ修飾した宛先を使い、旧原稿の返事も一度だけ載せる。
    function sectionNoteKey(id) {
      const separate = addresses.key('sectionNotes', id);
      if (isNumbered(id, 'S') && (a.archived?.[separate] || resolvedLabel(separate) || threads(a, separate).length)) return separate;
      return addresses.key('sections', id);
    }
    for (const s of a.userSections) {
      const body = bodyLine(s.body);
      append(s.id, s.id, (body ? '本文　' + body : 'セクションを追加') + files(s.attachments) + (a.archived?.[s.id] ? '（' + line(s.title) + '）' : ''), !a.sections[s.id]?.trim() || sectionNoteKey(s.id) !== s.id, body);
    }
    for (const r of [...a.requests].sort((one, two) => serial(one.id) - serial(two.id))) {
      const request = '依頼　' + bodyLine(r.text);
      append(r.target === WHOLE ? 'general' : r.target, r.id, request + files(r.attachments), true, request);
    }
    for (const [id, value] of Object.entries(a.sections)) {
      if (id !== 'general' && value.trim() && !sectionMap.get(id)?.settled) append(id, sectionNoteKey(id), bodyLine(value) + '（セクションコメント）');
    }
    const generalKey = addresses.key('sections', 'general');
    if (a.sections.general?.trim() || threads(a, generalKey).length || a.archived?.[generalKey]) {
      append('general', generalKey, bodyLine(a.sections.general ?? '') || '全体へのコメント');
    }
    for (const [id, value] of Object.entries(a.rows)) {
      const {section, row} = rows.get(id);
      if (value.trim()) append(section.id, addresses.key('rows', id), `${bodyLine(value)}（行「${line(row.title)}」）`, true, bodyLine(value));
    }
    for (const [id, value] of Object.entries(a.mocks)) {
      const {section, row} = mocks.get(id);
      const title = row.mockTitles?.[id];
      const context = `行「${line(row.title)}」の画面案` + (title ? '「' + line(title) + '」' : '');
      if (value.trim()) append(section.id, addresses.key('mocks', id), `${bodyLine(value)}（${context}）`, true, bodyLine(value));
    }

    // 元のコメントを空にした後でも、返事とその下の追記には宛先を付けて渡す。
    for (const s of doc.sections) {
      const key = addresses.key('sections', s.id);
      if (!s.settled && !a.sections[s.id]?.trim() && !a.approvedSections[s.id] && threads(a, key).length) append(s.id, key, 'セクション「' + line(s.title) + '」');
      for (const r of s.rows) {
        const candidates = [['rows', r.id, '行「' + line(r.title) + '」'], ...r.mocks.map(id => ['mocks', id, '画面案「' + line(r.mockTitles?.[id] ?? r.title) + '」'])];
        for (const [kind, id, label] of candidates) {
          const key = addresses.key(kind, id);
          if (!a[kind][id]?.trim() && threads(a, key).length) append(s.id, key, label);
        }
      }
    }
    const images = new Set([...Object.keys(a.attachments), ...Object.keys(a.photos), ...Object.keys(a.pins)]);
    for (const id of [...Object.keys(doc.figures), ...doc.issues.filter(i => i.file).map(i => i.id)]) {
      if (threads(a, addresses.key('photos', id)).length) images.add(id);
    }
    for (const id of images) {
      const attachment = a.attachments[id], marks = a.pins[id]?.items ?? [];
      const imageKey = addresses.key(attachment ? 'attachments' : 'photos', id);
      const description = attachment ? attachment.comment.trim() || '追加画像' : a.photos[id]?.trim() || (threads(a, imageKey).length ? '画像の説明' : '');
      if (!description && !marks.length) continue;
      const pic = picture(a, id);
      // 指摘の登録順が資料と異なる場合も、資料を上から読んで最初に出会うセクションに印をまとめる。
      const owners = attachment ? pic.sections : doc.sections.filter(s => pic.sections.includes(s.id)).map(s => s.id);
      const [owner = 'general', ...others] = owners;
      const context = [preview && attachment ? label(attachment.name) : '図「' + line(pic.title) + '」'];
      if (!preview && !copy && marks.length) context.push('印付き画像 ' + markedFile(id));
      if (!preview && !attachment && !marks.length && pic.file) context.push('原稿内 ' + pic.file);
      if (others.length) {
        context.push('関連するセクション' + others.map(key => '「' + line(sectionTitle(key, a)) + '」').join('・'));
        for (const key of others) {
          if (!sharedFrom.has(key)) sharedFrom.set(key, new Set());
          sharedFrom.get(key).add(owner);
        }
      }
      if (description) {
        const origin = attachment && !preview ? '、画像 ' + attachment.file : '';
        append(owner, imageKey, `${bodyLine(description)}（${context.join('、')}${origin}）`, true, bodyLine(description));
      }
      for (const mark of marks) {
        const size = isRange(mark) ? `, 幅=${mark.w}, 高さ=${mark.h}` : '';
        const position = `x=${mark.x}, y=${mark.y}${size}`;
        const key = markKey(imageKey, mark);
        // 画像自体への返事と、一つの印への返事をその入力の直下に出し分ける。
        const note = bodyLine(mark.comment) || 'コメントなし';
        append(owner, key, `${note}（${context.join('、')}、${position}）`, true,
          note + (preview || copy ? '' : '　' + markedFile(id)));
      }
    }

    const edition = typeof doc.built?.label === 'string' ? line(doc.built.label) : '';
    const blocks = ['# 回答：' + line(doc.title) + (edition ? '（' + edition + '）' : '')];
    if (doc.built?.number && !preview && (!a.answeredEdition || doc.built.label !== '第' + a.answeredEdition + '回')) {
      blocks.push('<!-- answeredEdition: ' + (a.answeredEdition ?? 'none') + ' -->');
    }
    const untouched = [], settled = [];
    // 判断の選択やセクション全体の了承は、そのコメントを完了にした後も元の判断に残す。
    function answerNote(owner, key, comment) {
      if (a.archived?.[key]) {
        append(owner, key, bodyLine(comment ?? '') || '補足');
        return {note: '', replies: []};
      }
      const resolved = resolvedLabel(key);
      return {note: (comment?.trim() ? '　補足「' + bodyLine(comment) + '」' : '') + (resolved ? '　' + resolved : ''),
        replies: conversation(key)};
    }
    function itemLine(d, item, answer, owner) {
      const id = d.id + '　' + item.id, key = addresses.key('itemComments', id);
      const {note, replies} = answerNote(owner, key, a.itemComments?.[id]);
      const choice = answer?.choice?.[item.id];
      const value = choice === item.recommended ? '推奨どおり' + quoted(choice)
        : (choice == null ? '未回答' : quoted(choice)) + '（推奨は' + quoted(item.recommended) + '）';
      return ['- ' + entry(item.figure || note || replies.length ? key : item.id, value + note), ...replies];
    }
    function section(heading, lines) {
      blocks.push('## ' + heading + '\n\n' + lines.join('\n'));
    }
    for (const s of doc.sections) {
      if (s.settled) {
        const id = addresses.key('sections', s.id);
        const {note, replies} = answerNote(s.id, id, a.sections[s.id]);
        settled.push(entry(id, 'セクション「' + line(s.title) + '」' + note), ...replies);
      }
      for (const d of doc.decisions.filter(d => d.section === s.id && (s.settled || d.settled))) {
        const answer = a.decisions[d.id], key = addresses.key('decisions', d.id);
        const summary = settledSummary(a, d);
        const {note, replies} = answerNote(s.id, key, answer?.comment);
        settled.push(entry(key, line(d.question) + ' → ' + summary + note), ...replies);
        for (const item of d.items ?? []) {
          const id = d.id + '　' + item.id, target = addresses.key('itemComments', id);
          if (a.itemComments?.[id] || threads(a, target).length || resolvedLabel(target) || a.archived?.[target]) {
            settled.push(...itemLine(d, item, answer, s.id));
          }
        }
      }
      if (s.settled) { settled.push(...(entries.get(s.id) ?? [])); continue; }
      const state = sectionState(a, s.id);
      const decisions = decisionsBySection.get(s.id);
      if (state === 'empty' && !entries.has(s.id) && !decisions.some(d => threads(a, addresses.key('decisions', d.id)).length
          || d.items?.some(item => threads(a, addresses.key('itemComments', d.id + '　' + item.id)).length))) {
        const indexOnly = !decisions.length && s.rows.length > 0 && s.rows.every(row => row.type === 'decisions');
        if (!indexOnly) untouched.push('- ' + line(s.title));
        continue;
      }
      const lines = [];
      let status;
      if (decisions.length) {
        status = state === 'done' ? '判断済み（コメントのない行は了承）' : '未確認の判断あり（コメントのない行は未確認）';
        if (state === 'hold') {
          const ids = decisions.filter(d => decisionDeferred(a.decisions[d.id])).map(d => d.id);
          status = '保留あり（' + ids.join('、') + '）';
        }
        for (const d of decisions) {
          const answer = a.decisions[d.id], key = addresses.key('decisions', d.id);
          const {note, replies} = answerNote(s.id, key, answer?.comment);
          if (d.items) {
            lines.push(entry(key, `${line(d.question)}（${itemProgress(d, answer, true)}）${note}`), ...replies);
            for (const item of d.items) lines.push(...itemLine(d, item, answer, s.id));
          } else {
            lines.push(entry(key, `${decisionText(d, answer)}${note}（${line(d.question)}）`), ...replies);
          }
        }
      } else if (state === 'done') {
        status = '了承';
        const key = addresses.key('sections', s.id);
        lines.push(entry(key, '了承'), ...(!a.sections[s.id]?.trim() && !a.archived?.[key] ? conversation(key) : []));
      } else {
        status = '記入あり（コメントのない行は未確認）';
      }
      lines.push(...(entries.get(s.id) ?? []));
      for (const owner of sharedFrom.get(s.id) ?? []) {
        lines.push('共有画像への記入はセクション「' + line(sectionTitle(owner, a)) + '」に掲載。');
      }
      if (lines.length) section('セクション「' + line(s.title) + '」　' + status, lines);
    }
    if (entries.has('general')) section('全体へのコメント', entries.get('general'));
    for (const s of a.userSections) {
      if (!a.archived?.[s.id]) section('利用者が追加したセクション「' + line(s.title) + '」', entries.get(s.id));
    }
    if (untouched.length) section('手を付けていないセクション', untouched);
    if (filed.size) settled.push('\n### 完了したもの\n', ...[...filed.values()].flatMap(group => group.flatMap(item => item.lines)));
    if (settled.length) section('決定事項', settled);
    return {markdown: blocks.join('\n\n') + '\n', filed};
  }

  /** 保存・コピー用の文面。同じ分類結果から決定事項ページの「完了したもの」も描画する。 */
  function markdown(a, options) {
    return reviewDocument(a, options).markdown;
  }

  /** 下書き中のU番号は仮番号。別の入力欄が先に画像を追加しても、確定時に本文と添付を一緒に付け替える。 */
  function submitDraft(a, media, kind, draft) {
    const next = {...a, attachments: {...a.attachments}, userSections: [...a.userSections]};
    const additions = {};
    const isSection = kind === 'section';
    const id = isSection ? draft.id ?? numbered('S', a.lastSectionNumber + 1) : draft.id;
    const owner = isSection ? id : draft.target === WHOLE ? 'general' : draft.target;
    const remap = new Map();
    const ids = [...new Set([...draft.attachments, ...inlineRefs(draft.text)])];
    if (!ids.every(id => isNumbered(id,'U') && (Object.hasOwn(draft.images,id) || Object.hasOwn(a.attachments,id)))) throw Error('添付画像を確認してください');
    for (const alias of ids) {
      const image = draftImage(draft, alias);
      if (Object.hasOwn(draft.images, alias)) {
        if (!pngData(image?.dataUrl)) throw Error('画像を読み込めません');
        remap.set(alias, addAttachment(next, additions, owner, image.dataUrl, image.name));
      } else if (Object.hasOwn(draft.renames ?? {}, alias)) {
        // 確定前の検査に失敗しても共有画像の元の名前を保つ。
        next.attachments[alias] = {...a.attachments[alias], name: normalizeImageName(draft.renames[alias])};
      }
    }
    const body = draft.text.replace(inlinePattern(), (match, alias) => remap.has(alias) ? '![' + remap.get(alias) + ']' : match);
    const links = ids.map(key => remap.get(key) ?? key);
    let result;
    if (isSection) {
      if (!text(draft.title) || !draft.title.trim() || !text(body) || !validLinks(links, next.attachments)) throw Error('セクションの題名・本文・画像を確認してください');
      const section = {id, title: draft.title.trim(), body, attachments: links};
      if (draft.id) {
        const index = next.userSections.findIndex(s => s.id === id);
        if (index < 0) throw Error('編集するセクションが見つかりません');
        next.userSections[index] = section;
      } else {
        if (!Number.isSafeInteger(++next.lastSectionNumber)) throw Error('セクションの番号を使い切りました');
        next.userSections.push(section);
      }
      result = id;
    } else {
      result = saveRequest(next, additions, {id, target: draft.target, text: body, attachments: links});
    }
    Object.assign(a, next);
    Object.assign(media, additions);
    return result;
  }

  return {empty, unpack, markdown, picture, figuresInSection, sectionTitle, targetLabel, saveRequest, submitDraft,
    activeDecisions, addresses, threads, replyLocation, recordEdition, followUp, settledSummary, setItemComment, setArchived, resolvedLabel,
    filedTitle, archivedItems: a => reviewDocument(a, {preview: true}).filed,
    canApproveSection, setSectionApproved, sectionProgress, sectionState};
}
