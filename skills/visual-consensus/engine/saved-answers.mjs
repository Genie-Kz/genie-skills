import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { replyAddresses, signature, WHOLE } from './model.mjs';

function missing(kind, id) {
  return `保存済みの回答がある${kind} ${id} が原稿にありません。id を変えた場合は元に戻してください。`;
}

function compareJson(answers, doc, ids) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(answers)) throw Error('回答のオブジェクトが必要です');
  if (answers.documentId && answers.documentId !== doc.id) {
    return [`answers.json の資料 ID「${answers.documentId}」と原稿の ID「${doc.id}」が異なります。同じ資料なら原稿の id を元に戻してください。`];
  }
  for (const field of ['rows', 'decisions', 'mocks', 'sections', 'approvedSections', 'photos', 'pins', 'attachments', 'itemComments']) {
    if (field in answers && !record(answers[field])) throw Error(field + ' の形式を確認してください');
  }
  for (const field of ['requests', 'userSections']) {
    if (field in answers && !Array.isArray(answers[field])) throw Error(field + ' の形式を確認してください');
  }
  const messages = new Set();
  const knownSections = new Set([...ids.sections.keys(), 'general', WHOLE,
    ...(answers.userSections ?? []).map(section => section.id)]);
  const photos = new Set([...Object.keys(doc.figures), ...doc.issues.filter(issue => issue.file).map(issue => issue.id)]);
  const pinTargets = new Set([...photos, ...Object.keys(answers.attachments ?? {})]);
  function check(known, kind, id) {
    if (typeof id === 'string' && !known.has(id)) messages.add(missing(kind, id));
  }
  for (const [field, kind, known] of [
    ['rows', '行', ids.rows], ['decisions', '判断', ids.decisions], ['mocks', '画面案', ids.mocks],
    ['sections', 'セクション', knownSections], ['approvedSections', 'セクション', knownSections],
    ['photos', '画像', photos], ['pins', '画像', pinTargets],
  ]) {
    for (const id of Object.keys(answers[field] ?? {})) check(known, kind, id);
  }
  for (const key of Object.keys(answers.itemComments ?? {})) {
    const [id, item] = key.split('　');
    check(ids.decisions, '判断', id);
    const decision = doc.decisions.find(d => d.id === id);
    if (decision) check(new Set(decision.items?.map(entry => entry.id)), `判断 ${id} の項目`, item);
  }
  for (const d of doc.decisions) {
    const savedItems = answers.decisions?.[d.id]?.choice;
    if (!record(savedItems)) continue;
    const itemIds = new Set(d.items?.map(item => item.id));
    for (const id of Object.keys(savedItems)) check(itemIds, `判断 ${d.id} の項目`, id);
  }
  for (const request of answers.requests ?? []) check(knownSections, 'セクション', request.target);
  for (const image of Object.values(answers.attachments ?? {})) check(knownSections, 'セクション', image.section);
  return [...messages];
}

// 保存済みの Markdown は再生成されないため、ID の照合と返事の宛先判定で新旧両方の目印を使う。
const userSectionEntryStart = /^(?:本文　|(?:セクション|節)を追加)/;
const sectionCommentSuffix = /（(?:セクション|節)コメント）$/;

// 状態は行頭の宛先に付く注記。保存済みの文面は「版」「回」のどちらで書かれていても照合する。
function answerLines(markdown) {
  return markdown.replace(/　(?:✓ 対応済み（第\d+[版回]）|完了|片付け済み)(?=　|\r?$)/gm, '').split(/\r?\n/);
}

// Markdown だけが残っていても、キットが行頭に書いた回答 ID は照合できる。
// 自由記述や依頼者自身が発行した画像・依頼・セクションの番号は、原稿の ID とみなさない。
function compareMarkdown(markdown, doc, ids) {
  const messages = new Set();
  const itemIds = new Map(doc.decisions.map(d => [d.id, new Set(d.items?.map(item => item.id))]));
  let table;
  for (const line of answerLines(markdown)) {
    if (/^　(?:返事（第\d+[版回]）|追記「)/.test(line)) continue;
    // 画像付き項目は判断と項目の両方を行頭に持つ。旧形式の行は直前の判断から補う。
    const card = /^- (?:decisions:)?([A-Za-z][\w-]*)　([A-Za-z][\w-]*)　(.+)$/.exec(line);
    if (card) {
      if (!itemIds.has(card[1])) messages.add(missing('判断', card[1]));
      else if (!itemIds.get(card[1]).has(card[2]) && (!card[3].startsWith('未回答（') || card[3].includes('　補足「'))) {
        messages.add(missing(`判断 ${card[1]} の項目`, card[2]));
      }
      continue;
    }
    const item = table && /^- ([A-Za-z][A-Za-z0-9_-]*)　(.+)$/.exec(line);
    if (item) {
      if (!item[2].startsWith('未回答（') && !itemIds.get(table).has(item[1])) {
        messages.add(missing(`判断 ${table} の項目`, item[1]));
      }
      continue;
    }
    table = undefined;
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)　(.+)$/.exec(line);
    if (!entry) continue;
    const [, id, body] = entry;
    if (/^未回答（/.test(body) || (/^R-\d+$/.test(id) && body.startsWith('依頼　')) ||
        (/^S-\d+$/.test(id) && userSectionEntryStart.test(body))) continue;
    if (/（\d+件中\d+件）(?:　補足「.*」)?$/.test(body) && itemIds.has(id)) {
      table = id;
      continue;
    }
    let known, kind;
    if (body === '了承' || sectionCommentSuffix.test(body)) {
      if (/^S-\d+$/.test(id)) continue;
      known = ids.sections; kind = 'セクション';
    } else if (/（行「.*」の画面案(?:「.*」)?）$/.test(body)) {
      known = ids.mocks; kind = '画面案';
    } else if (/（行「.*」）$/.test(body)) {
      known = ids.rows; kind = '行';
    } else if (/（図「.*）$/.test(body)) {
      if (/^U-\d+$/.test(id)) continue;
      known = ids.images; kind = '画像';
    } else if (/（.+）$/.test(body)) {
      known = ids.decisions; kind = '判断';
    } else continue;
    if (!known.has(id)) messages.add(missing(kind, id));
  }
  return [...messages];
}

function hasJsonAnswers(answers) {
  if (typeof answers.general === 'string' && answers.general.trim()) return true;
  // ピンを全部消しても次の番号は残る。返事の履歴にも、利用者がまだ追記していない項目がある。
  if (Object.values(answers.pins ?? {}).some(group => Array.isArray(group?.items) && group.items.length > 0)) return true;
  if (Object.values(answers.threads ?? {}).some(history => Array.isArray(history) &&
      history.some(item => typeof item?.comment === 'string' && item.comment.trim()))) return true;
  return ['rows', 'mocks', 'decisions', 'itemComments', 'photos', 'sections', 'approvedSections', 'attachments', 'requests', 'userSections']
    .some(field => Object.keys(answers[field] ?? {}).length > 0);
}

// Markdown だけが残っているときも、未回答の選択肢と利用者が書いた補足を区別する。
function hasMarkdownAnswers(markdown) {
  return answerLines(markdown).some(line => {
    if (line.startsWith('　追記「')) return true;
    const body = /^(?:全体|[A-Za-z][\w:-]*)　(.+)$/.exec(line)?.[1]
      ?? /^- (?:decisions:)?[A-Za-z][\w-]*　[A-Za-z][\w-]*　(.+)$/.exec(line)?.[1];
    if (!body) return false;
    if (body.includes('　補足「')) return true;
    return !/^未回答(?:（|　|$)/.test(body) && !/（\d+件中0件）$/.test(body);
  });
}

/** 回答ファイルは読み取り専用。壊れた回答や別資料の回答も、ビルドを中断せず要約の後で伝える。 */
export async function readSavedReview(folder, doc, ids) {
  const messages = [], addresses = replyAddresses(doc);
  let answers, markdown = '', hasJson = false;
  try {
    const parsed = JSON.parse(await readFile(path.join(folder, 'answers.json'), 'utf8'));
    messages.push(...compareJson(parsed, doc, ids));
    hasJson = true;
    if ((!parsed.documentId || parsed.documentId === doc.id) && (!parsed.version || parsed.version === doc.version)) answers = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') messages.push('out/answers/answers.json を照合できません。ファイルの内容と読み取り権限を確認してください。');
  }
  try {
    if (!hasJson || (answers && !answers.answeredEdition)) markdown = await readFile(path.join(folder, 'answers.md'), 'utf8');
    if (!hasJson) {
      messages.push('answers.md に記載された ID を照合しました。依頼先のセクションなども照合するには、対応する answers.json を同じフォルダに置いてください。');
      messages.push(...compareMarkdown(markdown, doc, ids));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') messages.push('out/answers/answers.md を読み取れません。読み取り権限を確認してください。');
  }
  let targets = addresses.targets();
  try { targets = addresses.targets(answers); } catch { /* 旧形式の一部だけが残っていれば、原稿の宛先を照合する。 */ }
  if (!hasJson) {
    for (const line of answerLines(markdown)) {
      const entry = /^([A-Za-z][\w:-]*)　(.+)$/.exec(line);
      if (!entry) continue;
      const [, id, body] = entry;
      if ((/^R-\d+$/.test(id) && body.startsWith('依頼　')) ||
          (/^S-\d+$/.test(id) && (userSectionEntryStart.test(body) || sectionCommentSuffix.test(body))) ||
          /^U-\d+$/.test(id)) targets.add(id);
      if (/^(?:sections:)?S-\d+$/.test(id) && sectionCommentSuffix.test(body)) {
        targets.add('sections:' + id.split(':').at(-1));
      }
      const mark = /^(ピン|範囲)([1-9]\d*)　/.exec(body);
      if (mark && targets.has(id)) targets.add(id + '　' + mark[1] + mark[2]);
    }
  }
  for (const key of doc.resolved ?? []) {
    if (!targets.has(key)) messages.push('対応済みの宛先「' + key + '」が見つかりません。answers.md の行頭を確認してください。');
  }
  for (const key of Object.keys(doc.replies ?? {})) {
    if (!targets.has(key)) messages.push('返事の宛先「' + key + '」が見つかりません。answers.md の行頭を確認してください。');
  }
  const markedEdition = markdown.match(/^<!-- answeredEdition: (\d+|none) -->$/m)?.[1];
  const hasAnswers = answers ? hasJsonAnswers(answers) : markedEdition !== 'none' && hasMarkdownAnswers(markdown);
  // 旧見出しは表示名なので実際の回答があるときだけ使う。空の JSON は以前の Markdown に優先する。
  const headingEdition = hasAnswers ? markdown.split(/\r?\n/, 1)[0].match(/（第(\d+)[版回]）$/)?.[1] : undefined;
  const edition = answers?.answeredEdition ?? (hasAnswers || !hasJson ? Number(markedEdition ?? headingEdition) : null);
  const legacyKey = hasAnswers && !answers?.answeredEdition
    ? createHash('sha256').update(answers ? signature(answers) : markdown).digest('hex').slice(0, 24) : null;
  return {answers, targets, warnings: messages, hasAnswers, legacyKey, edition: Number.isSafeInteger(edition) && edition > 0 ? edition : null};
}
