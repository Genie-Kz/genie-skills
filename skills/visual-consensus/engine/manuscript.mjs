import { DEFER, OTHER, optionLabel, validReplyKey } from './model.mjs';

const fields = {
  document: ['id', 'title', 'version', 'edition', 'sections', 'decisions', 'figures', 'issues',
    'style', 'script', 'art', 'acceptLegacy', 'references', 'replies', 'resolved'],
  section: ['id', 'title', 'group', 'lead', 'rows', 'sources', 'settled'],
  row: ['id', 'title', 'html', 'type'],
  decision: ['id', 'section', 'question', 'options', 'recommended', 'context', 'label', 'multiple', 'max', 'none', 'other', 'items', 'settled', 'decided'],
  decided: ['answer', 'via'],
  option: ['label', 'note'],
  item: ['id', 'label', 'recommended', 'figure', 'note'],
  figure: ['file', 'title', 'width', 'height', 'source', 'box'],
  issue: ['id', 'sections', 'summary', 'file', 'preview', 'originalLabel', 'batch'],
};

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

function distance(one, two) {
  let previous = Array.from({length: two.length + 1}, (_, index) => index);
  for (const character of one) {
    const row = [previous[0] + 1];
    for (let index = 0; index < two.length; index++) {
      row.push(Math.min(row[index] + 1, previous[index + 1] + 1,
        previous[index] + Number(character !== two[index])));
    }
    previous = row;
  }
  return previous[two.length];
}

function checkFields(value, kind, where) {
  if (!isRecord(value)) throw Error(`${where}にはオブジェクトを指定してください。`);
  const allowed = fields[kind];
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const [nearest] = [...allowed].sort((a, b) => distance(key, a) - distance(key, b));
    throw Error(`${where} に未知の項目「${key}」があります。候補は「${nearest}」です。使える項目: ${allowed.join(', ')}`);
  }
}

function checkId(id, where) {
  if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || Object.hasOwn(Object.prototype, id)) {
    throw Error(`${where} の ID「${id ?? ''}」は使えません。英字で始まる英数字・ハイフン・アンダースコアの固有名を付けてください（例: enter-name）。`);
  }
}

function addId(owners, id, where) {
  checkId(id, where);
  if (owners.has(id)) {
    throw Error(`${where} が2回使われています。最初の指定は ${owners.get(id)} です。それぞれに異なる ID を付けてください。`);
  }
  owners.set(id, where);
}

function checkSection(id, where, sections) {
  if (!sections.has(id)) {
    throw Error(`${where}「${id ?? ''}」に対応するセクションが原稿にありません。登録済みのセクション: ${[...sections.keys()].join(', ')}`);
  }
}

function checkImageId(ids, id, where) {
  if (/^U-\d+$/.test(id)) throw Error(`${where} は追加画像用の ID です。別の ID を付けてください。`);
  addId(ids, id, where);
}

function checkOptions(options, where) {
  if (!Array.isArray(options) || options.length < 2) {
    throw Error(`${where} の options に異なる選択肢を2つ以上指定してください。現在: ${JSON.stringify(options ?? [])}`);
  }
  const labels = new Set();
  for (const [i, option] of options.entries()) {
    const at = `${where} の options[${i}]`;
    if (typeof option !== 'string') {
      checkFields(option, 'option', at);
      if (option.note !== undefined && (typeof option.note !== 'string' || /[\r\n\u2028\u2029]/.test(option.note))) {
        throw Error(`${at} の note に選んだ結果を1行で書いてください。`);
      }
    }
    const label = optionLabel(option);
    if (!isText(label) || labels.has(label) || label === DEFER) {
      throw Error(`${at} の label「${label ?? ''}」は使えません。空欄・重複・自動で加わる「保留」を除いてください。`);
    }
    labels.add(label);
  }
  return labels;
}

function checkRecommendation(value, labels, where) {
  if (!labels.has(value)) {
    throw Error(`${where} の recommended「${value ?? ''}」が options にありません。options: ${[...labels].join(', ')}`);
  }
}

function checkDecision(d, ids, index, {sections, figures}) {
  const where = d?.id ? `判断 ${d.id}` : `decisions[${index}]`;
  checkFields(d, 'decision', where);
  addId(ids.decisions, d.id, where);
  checkSection(d.section, where + ' の section', ids.sections);
  if (!isText(d.question)) throw Error(`${where} の question に質問文を書いてください。`);
  const labels = checkOptions(d.options, where);
  for (const key of ['multiple', 'other', 'settled']) {
    if (d[key] !== undefined && typeof d[key] !== 'boolean') throw Error(`${where} の ${key} に true または false を指定してください。`);
  }
  if (d.decided !== undefined) {
    if (!d.settled && !sections.find(section => section.id === d.section).settled) {
      throw Error(`${where} の decided は、判断またはセクションに settled: true を指定したときに書けます。`);
    }
    checkFields(d.decided, 'decided', where + ' の decided');
    if (!isText(d.decided.answer)) throw Error(`${where} の decided.answer に決まった答えを書いてください。`);
    if (d.decided.via !== undefined && !isText(d.decided.via)) throw Error(`${where} の decided.via に決めた場所を書いてください。`);
  }
  if (!d.multiple && (d.max !== undefined || d.none !== undefined)) {
    throw Error(`${where} の max と none は multiple: true の判断で指定してください。`);
  }
  if (d.items !== undefined) {
    if (!Array.isArray(d.items) || !d.items.length) throw Error(`${where} の items に {id, label, recommended} を1件以上指定してください。`);
    if (d.multiple !== undefined || d.other === true || d.recommended !== undefined) {
      throw Error(`${where} の items と併用した multiple・other: true・判断全体の recommended を外し、各項目に recommended を指定してください。`);
    }
    const itemIds = new Map();
    for (const [i, item] of d.items.entries()) {
      const at = `${where} の items[${i}]`;
      checkFields(item, 'item', at);
      addId(itemIds, item.id, at + ' の項目 ' + (item.id ?? ''));
      if (!isText(item.label)) throw Error(`${at} の label に項目名を書いてください。`);
      if (item.figure !== undefined && (!isText(item.figure) || !Object.hasOwn(figures, item.figure))) {
        throw Error(`${at}（${item.id}）の図 ${JSON.stringify(item.figure)} が figures にありません。figure の ID を直すか figures に追加してください。`);
      }
      if (item.note !== undefined && (typeof item.note !== 'string' || /[\r\n\u2028\u2029]/.test(item.note))) {
        throw Error(`${at}（${item.id}）の note に項目の説明を1行で書いてください。`);
      }
      checkRecommendation(item.recommended, labels, at);
    }
  } else if (d.multiple) {
    if (!Array.isArray(d.recommended) || !d.recommended.length || new Set(d.recommended).size !== d.recommended.length) {
      throw Error(`${where} の recommended に重複しない label を1つ以上、配列で指定してください。options: ${[...labels].join(', ')}`);
    }
    for (const rec of d.recommended) checkRecommendation(rec, labels, where);
    if (d.max !== undefined && (!Number.isSafeInteger(d.max) || d.max < d.recommended.length)) {
      throw Error(`${where} の max に推奨の数（${d.recommended.length}）以上の整数を指定してください。`);
    }
    if (d.none !== undefined && (!isText(d.none) || labels.has(d.none) || [DEFER, OTHER].includes(d.none))) {
      throw Error(`${where} の none に options・その他・保留と重複しない名前を指定してください。options: ${[...labels].join(', ')}`);
    }
  } else {
    checkRecommendation(d.recommended, labels, where);
  }
}

function prepareRow(row, section, index, ids, figures) {
  const where = `セクション ${section.id} の${row?.id ? '行 ' + row.id : ' rows[' + index + ']'}`;
  checkFields(row, 'row', where);
  addId(ids.rows, row.id, where);
  if (!isText(row.title)) throw Error(`${where} の title に行の題名を書いてください。`);
  if (row.type !== undefined && !['issues', 'decisions'].includes(row.type)) {
    throw Error(`${where} の type「${row.type}」は使えません。一覧には issues または decisions、本文には html を指定してください。`);
  }
  if ((row.html !== undefined || row.type === undefined) && typeof row.html !== 'string') {
    throw Error(`${where} の html に本文を書くか、type に issues または decisions を指定してください。`);
  }
  const html = (row.html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  row.photos = [...new Set(Array.from(html.matchAll(/\bdata-photo\s*=\s*(["'])([^"']+)\1/g), match => match[2]))];
  for (const photo of row.photos) {
    if (!Object.hasOwn(figures, photo)) throw Error(`${where} の図 ${photo} が figures にありません。fig() の ID を直すか figures に追加してください。`);
  }
  const mocks = Array.from(html.matchAll(/\bdata-mock\s*=\s*(["'])([^"']+)\1/g));
  row.mocks = mocks.map(match => match[2]);
  // mock() の見出しを回答の宛先に使う。次の画面案の題名が混ざらないよう区切る。
  row.mockTitles = Object.fromEntries(row.mocks.flatMap((id, index) => {
    addId(ids.mocks, id, `${where} の画面案 ${id}`);
    const part = html.slice(mocks[index].index, mocks[index + 1]?.index);
    const title = part.match(/\bclass\s*=\s*(["'])mock-title\1\s*>([^<]*)</)?.[2];
    return title ? [[id, title]] : [];
  }));
}

/** 原稿の複製に表示用の行情報を付ける。返す ID 台帳は回答の参照先の照合にも使う。 */
export function prepareManuscript(source) {
  checkFields(source, 'document', '原稿の export default');
  const doc = structuredClone(source);
  checkId(doc.id, '原稿');
  if (!isText(doc.title) || /[\\/:*?"<>|\x00-\x1f]/.test(doc.title) || /[. ]$/.test(doc.title)) {
    throw Error('原稿の title にファイル名として使える題名を書いてください。末尾の空白・ピリオドも除いてください。');
  }
  if (!isText(doc.version) && !(Number.isFinite(doc.version) && doc.version !== 0)) {
    throw Error('原稿の version に、回答と照合する識別子を指定してください（例: r1）。');
  }
  if (!Array.isArray(doc.sections) || !doc.sections.length) throw Error('原稿の sections に1件以上のセクションを指定してください。');
  doc.figures ??= {};
  doc.issues ??= [];
  doc.decisions ??= [];
  if (doc.replies !== undefined && (!isRecord(doc.replies) || !Object.values(doc.replies).every(isText))) {
    throw Error('原稿の replies には、回答の ID をキーにして返事の文を書いてください。');
  }
  if (doc.resolved !== undefined && (!Array.isArray(doc.resolved) || !doc.resolved.every(validReplyKey)
      || new Set(doc.resolved).size !== doc.resolved.length)) {
    throw Error('原稿の resolved には、answers.md の行頭のキーを重複のない配列で指定してください。');
  }
  if (!isRecord(doc.figures)) throw Error('原稿の figures に図の ID をキーとしたオブジェクトを指定してください。');
  if (!Array.isArray(doc.issues)) throw Error('原稿の issues を配列にしてください（例: []）。');
  if (!Array.isArray(doc.decisions)) throw Error('原稿の decisions を配列にしてください（例: []）。');

  const ids = {sections: new Map(), rows: new Map(), decisions: new Map(), mocks: new Map(), images: new Map()};
  for (const [index, section] of doc.sections.entries()) {
    const where = section?.id ? `セクション ${section.id}` : `sections[${index}]`;
    checkFields(section, 'section', where);
    addId(ids.sections, section.id, where);
    if (section.settled !== undefined && typeof section.settled !== 'boolean') throw Error(`${where} の settled に true または false を指定してください。`);
    if (section.id === 'general' || /^S-\d+$/.test(section.id)) throw Error(`${where} は予約済みです。別のセクション ID を付けてください。`);
    if (!isText(section.title)) throw Error(`${where} の title にセクションの題名を書いてください。`);
    if (!Array.isArray(section.rows)) throw Error(`${where} の rows に行の配列を指定してください（例: []）。`);
    section.rows.forEach((row, i) => prepareRow(row, section, i, ids, doc.figures));
  }
  doc.decisions.forEach((decision, i) => checkDecision(decision, ids, i, doc));
  for (const [id, figure] of Object.entries(doc.figures)) {
    checkImageId(ids.images, id, `図 ${id}`);
    checkFields(figure, 'figure', `図 ${id}`);
    if (!isText(figure.file)) throw Error(`図 ${id} の file に画像の相対パスを書いてください（例: fig/a.png）。`);
  }
  for (const [index, issue] of doc.issues.entries()) {
    const where = issue?.id ? `指摘 ${issue.id}` : `issues[${index}]`;
    checkFields(issue, 'issue', where);
    checkImageId(ids.images, issue.id, where);
    if (!isText(issue.summary)) throw Error(`${where} の summary に指摘の要約を書いてください。`);
    if (!Array.isArray(issue.sections) || !issue.sections.length) throw Error(`${where} の sections に対象のセクション ID を1つ以上指定してください。`);
    for (const id of issue.sections) checkSection(id, where + ' の sections', ids.sections);
    const crop = issue.preview;
    if (crop != null && !(Array.isArray(crop) && crop.length === 4 &&
        crop.every(n => Number.isSafeInteger(n) && n >= 0) && crop[2] > 0 && crop[3] > 0)) {
      throw Error(`${where} の preview は原本上の [左, 上, 幅, 高さ] の整数ピクセルで指定してください。幅と高さは1以上です。`);
    }
  }
  return {doc, ids};
}
