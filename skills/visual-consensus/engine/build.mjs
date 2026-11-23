import { readFile, writeFile, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import nodeModule from 'node:module';
import path from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeHtml } from './parts.mjs';
import { initManuscript } from './init.mjs';
import { prepareManuscript } from './manuscript.mjs';
import { readSavedReview } from './saved-answers.mjs';
import { currentReplies, manuscriptHash } from './editions.mjs';
import { answerModel, recordedDecision, signature } from './model.mjs';

const engine = path.dirname(fileURLToPath(import.meta.url));
const parts = new URL('./parts.mjs', import.meta.url).href;
const usage = '使い方　node <スキル>/engine/build.mjs <原稿.mjs>\n'
  + '　　　　node <スキル>/engine/build.mjs --init docs/visual-consensus/YYYY-MM-DD-<話題> [--with-images]';
const mime = {'.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.avif':'image/avif'};

async function readAsset(root, where, file, encoding) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw Error(`${where} のファイル「${file}」は原稿フォルダ内の相対パスで指定してください。`);
  }
  try {
    return await readFile(path.join(root, file), encoding);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw Error(`${where} のファイル ${file} が見つかりません（原稿からの相対パス）。${root} からの位置とファイル名を確認してください。`);
    }
    throw error;
  }
}

async function imageSource(root, where, file) {
  const bytes = await readAsset(root, where, file);
  const type = mime[path.extname(file).toLowerCase()];
  if (!type) throw Error(`${where} の形式「${file}」は使えません。画像の拡張子: ${Object.keys(mime).join(', ')}`);
  return `data:${type};base64,${bytes.toString('base64')}`;
}

function json(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

// 再ビルドや同時実行でも、利用者が編集した案内と Git の設定を保持する。
async function writeIfMissing(file, contents) {
  try {
    await writeFile(file, contents, {flag: 'wx'});
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// 各ビルドに固有の目印だけを外す。同時に別のビルドが取得した空でないフォルダは rmdir で消えない。
async function releaseClaim(directory, marker) {
  for (let attempt = 0; ; attempt++) {
    try {
      try { await unlink(path.join(directory, marker)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rmdir(directory);
      return;
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return;
      // Windows では別プロセスが同じ停止済みの目印を削除中でも EPERM になる。
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function publishLocked(out, publish) {
  const lock = path.join(out, '.edition.lock');
  const host = createHash('sha256').update(hostname()).digest('hex').slice(0, 12);
  const marker = host + '.' + process.pid + '.' + randomUUID();
  const candidate = path.join(out, '.edition.' + marker);
  await mkdir(candidate);
  let acquired = false;
  try {
    // 所有者の目印があるフォルダを一度に公開する。生成途中の目印を停止済みプロセスと取り違えない。
    await writeFile(path.join(candidate, marker), '');
    for (let attempt = 0; !acquired; attempt++) {
      try { await rename(candidate, lock); acquired = true; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const occupants = await readdir(lock).catch(cause => {
          if (cause.code !== 'ENOENT') throw cause;
          return [];
        });
        const [owner] = occupants;
        if (occupants.length === 1 && owner.startsWith(host + '.')) {
          const pid = Number(owner.split('.')[1]);
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (probe) {
              if (probe.code === 'ESRCH') { await releaseClaim(lock, owner); continue; }
            }
          }
        } else if (!owner) {
          // 強制終了が目印の解放とフォルダの解放の間に入っても、次のビルドが引き継げる。
          try { await rmdir(lock); }
          catch (cause) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cause.code)) throw cause; }
        }
        if (attempt >= 150) throw Error('別のビルドが回の情報を保存中です。完了してから再実行してください。');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return await publish();
  } finally {
    await releaseClaim(acquired ? lock : candidate, marker);
  }
}

async function publishFile(file, contents) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, {flag: 'wx'});
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// 旧 HTML の style は「共通 CSS、原稿専用 CSS、画像用 :root」の順で、境界の印はない。
// 同梱されていた共通 CSS の長さと SHA-256 は LF にそろえた値。識別できたシートだけを切り離す。
function legacyStyle(html, kitStyle) {
  const sheet = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]?.replaceAll('\r\n', '\n');
  if (!sheet) return null;
  const variables = sheet.lastIndexOf('\n:root{');
  if (variables < 0 || !sheet.endsWith('}')) return null;
  const combined = sheet.slice(0, variables);
  const kit = kitStyle.replaceAll('\r\n', '\n');
  if (combined.startsWith(kit + '\n')) return combined.slice(kit.length + 1);

  const oldKitLength = 44179;
  const oldKitHash = 'bf7f81841dd7b95added2a2773a84f478d49bf8a2083794d948dcce133b9fcec';
  if (combined[oldKitLength] !== '\n' ||
      createHash('sha256').update(combined.slice(0, oldKitLength)).digest('hex') !== oldKitHash) return null;
  return combined.slice(oldKitLength + 1);
}

// true は原稿の一致、false は不一致。旧 HTML からどちらとも決められなければ null を返す。
async function compareLegacyManuscript(out, last, current) {
  const candidates = new Set();
  const files = await readdir(out, {withFileTypes: true}).catch(() => []);
  for (const file of files) {
    if (!file.isFile() || !file.name.toLowerCase().endsWith('.html')) continue;
    const html = await readFile(path.join(out, file.name), 'utf8').catch(() => '');
    const data = html.match(/<script type="application\/json" id="review-data">([^<]+)<\/script>/)?.[1];
    if (!data) continue;
    let payload;
    try { payload = JSON.parse(data); } catch { continue; }
    if (!Array.isArray(payload?.doc?.sections) || !payload.doc.built || !payload.assets ||
        typeof payload.assets !== 'object' || Array.isArray(payload.assets)) continue;

    const {built, ...doc} = payload.doc;
    // 旧キットは回の表示名と日時を埋め込む直前の HTML を記録した。改題前のファイルもこの値で特定できる。
    const original = html.replace(data, () => json({...payload, doc}));
    const exact = createHash('sha256').update(original).digest('hex') === last.hash
      || createHash('sha256').update(html).digest('hex') === last.hash;
    // 番号のない HTML では当時の表示名を照合する。原稿で表示名を指定した場合はその名前を使う。
    const labels = doc.edition == null ? [`第${last.number}回`, `第${last.number}版`] : [doc.edition];
    const editionMatches = built.number === undefined ? labels.includes(built.label) : built.number === last.number;
    if (!exact && (doc.id !== current.id || built.full !== last.builtAt + ' に作成' || !editionMatches)) continue;

    delete doc.replyEditions;
    delete doc.resolvedEditions;
    delete doc.settledAnswers;
    delete doc.changes;
    const style = doc.style ? legacyStyle(html, current.kitStyle) : '';
    // CSS の境界が不明でも、同じ CSS を与えてハッシュが違えば原稿か画像が変わっている。
    const matches = manuscriptHash(doc, payload.assets, style ?? current.style) === current.hash;
    const result = style === null && matches ? null : matches;
    if (exact) return result;
    // 改行変換などで旧ハッシュが合わない場合も、同じ資料・回・日時の候補が判定まで一致すれば使える。
    candidates.add(result);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

async function build(entry) {
  const root = path.dirname(entry);
  // 章からの静的 import にも効くよう、原稿のモジュールグラフを読む前に公開名を登録する。
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === 'visual-consensus' ? parts : specifier, context);
    },
  });
  const {doc, ids} = prepareManuscript((await import(pathToFileURL(entry))).default);
  const assets = {};
  for (const [id, figure] of Object.entries(doc.figures)) assets[id] = await imageSource(root, '図 ' + id, figure.file);
  for (const issue of doc.issues) {
    if (issue.file != null) assets[issue.id] = await imageSource(root, '指摘 ' + issue.id, issue.file);
  }
  const cssVars = Object.entries(doc.art ?? {}).map(([name, id]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !Object.hasOwn(assets, id)) {
      throw Error(`原稿の art「${name}」の変数名と画像 ID「${id}」を確認してください。登録済みの画像: ${Object.keys(assets).join(', ')}`);
    }
    return `--${name}:url("${assets[id]}")`;
  }).join(';');
  const style = doc.style ? await readAsset(root, 'style', doc.style, 'utf8') : '';
  // 配列の並びは資料の一部。オブジェクトのキーの記述順は回の番号に影響させない。
  const source = signature({doc, assets, style});
  const legacyHash = createHash('sha256').update(source).digest('hex');
  const kitStyle = await readFile(path.join(engine, 'sheet.css'), 'utf8');
  const css = kitStyle + (doc.style ? '\n' + style : '') + `\n:root{${cssVars}}`;
  delete doc.references;
  for (const section of doc.sections) delete section.sources;
  const hash = manuscriptHash(doc, assets, style);

  // file:// で開いた HTML がエンジンや画像を読み直さずに済むよう、全モジュールを埋め込む。
  const imports = {};
  for (const name of ['parts', 'model', 'decision-links', 'decision-controls', 'revision-view', 'storage', 'photo', 'editor', 'requests', 'topbar', 'edition-watch', 'client']) {
    const bytes = await readFile(path.join(engine, name + '.mjs'));
    imports['review-kit/' + name] = 'data:text/javascript;base64,' + bytes.toString('base64');
  }
  const demo = doc.script ? (await readAsset(root, 'script', doc.script, 'utf8')).replace(/<\/script/gi, '<\\/script') : '';
  const template = await readFile(path.join(engine, 'document.html'), 'utf8');
  const render = () => template.replace(/\{\{(TITLE|CSS|IMPORTS|DATA|DEMO)\}\}/g, (_, key) => ({
    TITLE: escapeHtml(doc.title), CSS: css, IMPORTS: json({imports}), DATA: json({doc, assets}), DEMO: demo,
  })[key]);

  // 原稿と素材をすべて検証してから出力する。エラーを直す間も前の HTML と回答を使える。
  const out = path.join(root, 'out'), answerFolder = path.join(out, 'answers');
  await mkdir(answerFolder, {recursive: true});
  // ルートに置く HTML だけを対象にし、回答と回の番号は Git で引き継ぐ。
  await writeIfMissing(path.join(out, '.gitignore'), '/*.html\n');
  await publishLocked(out, () => publishEdition({out, answerFolder, doc, ids, legacyHash, hash, kitStyle, style, render}));
}

async function publishEdition({out, answerFolder, doc, ids, legacyHash, hash, kitStyle, style, render}) {
  const editionFile = path.join(out, '.edition.json');
  const hashFormat = 'manuscript-v2';
  const last = await readFile(editionFile, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const saved = await readSavedReview(answerFolder, doc, ids);
  const previousNumber = last?.number ?? 1;
  // 番号のない旧回答は初めて読んだ回に結び付ける。同じ回答を次の回への回答として数え直さない。
  const legacyAnswer = saved.legacyKey ? {key: saved.legacyKey, edition: saved.edition
    ?? (last?.legacyAnswer?.key === saved.legacyKey ? last.legacyAnswer.edition : previousNumber)} : null;
  const answeredEdition = saved.edition ?? legacyAnswer?.edition;
  const answeredCurrent = Number.isSafeInteger(answeredEdition) && answeredEdition >= previousNumber;

  let same = last?.hashFormat === 'manuscript-v1' ? last.hash === legacyHash
    : last?.hashFormat === hashFormat && last.hash === hash;
  if (last && last.hashFormat === undefined) {
    // 以前の HTML を上書きする前に原稿を復元する。回答の有無を使うのは復元できない初回だけ。
    const matches = await compareLegacyManuscript(out, last, {id: doc.id, hash, style, kitStyle});
    if (matches !== null) {
      same = matches;
    } else {
      same = !(saved.answers && answeredCurrent);
      const decision = same ? `第${last.number}回の回答を確認できないため、第${last.number}回を引き継ぎます。`
        : `第${last.number}回以降の回答があるため、第${last.number + 1}回に進めます。`;
      saved.warnings.push('旧形式の HTML から前回の原稿を復元できません。answers.json に' + decision);
    }
  }
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  let number = previousNumber, revision = last?.revision ?? 0;
  if (last && !same) {
    if (answeredCurrent) {
      number++;
      revision = 0;
    } else {
      revision++;
    }
  }
  const builtAt = same && last.builtAt ? last.builtAt
    : `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const replies = currentReplies(doc.replies, last, number);
  doc.replyEditions = Object.fromEntries(Object.entries(replies)
    .filter(([key]) => saved.targets.has(key)).map(([key, [posted]]) => [key, posted]));
  // 同じキーを次の原稿にも残した場合は、最初に対応済みとした回を引き継ぐ。
  const resolved = Object.fromEntries((doc.resolved ?? []).map(key => [key, last?.resolved?.[key] ?? number]));
  doc.resolvedEditions = Object.fromEntries(Object.entries(resolved).filter(([key]) => saved.targets.has(key)));
  doc.built = {number, revision, hash, label: doc.edition ?? `第${number}回`, full: builtAt + ' に作成'};
  if (saved.hasAnswers && !saved.answers?.answeredEdition) doc.built.legacyAnsweredEdition = answeredEdition;
  // 新しい端末で開いた直後にも、片付いた判断の確定した答えを読めるようにする。
  const model = answerModel(doc);
  let recorded;
  if (saved.answers) {
    try { recorded = model.unpack(saved.answers).answers; } catch { /* 以前の不完全な回答はフォルダに残す。 */ }
  }
  if (recorded) {
    doc.settledAnswers = {};
    for (const d of doc.decisions) {
      if (model.activeDecisions.includes(d)) continue;
      const answer = recordedDecision(d, recorded.decisions[d.id]);
      if (answer === undefined) continue;
      doc.settledAnswers[d.id] = answer;
      if (d.decided) saved.warnings.push(`判断 ${d.id} には資料内の回答と原稿の decided が両方あります。資料内の回答を表示します。`);
    }
  }
  const state = {number, revision, hashFormat, hash, builtAt, replies};
  if (doc.resolved?.length) state.resolved = resolved;
  if (legacyAnswer) state.legacyAnswer = legacyAnswer;
  // 回の番号と返事を書いた回を先に確定する。途中で止まっても同じ原稿を再ビルドすれば同じ回の HTML を復元できる。
  await publishFile(editionFile, JSON.stringify(state) + '\n');
  await publishFile(path.join(out, doc.title + '.html'), render());
  await writeIfMissing(path.join(answerFolder, 'README.md'), await readFile(path.join(engine, 'answers-readme.md')));
  // 開いている資料が未完成の HTML を読み直さないよう、切り替えの印を最後に公開する。
  const markerPath = path.join(answerFolder, '.edition.json');
  const marker = JSON.stringify({number, revision, hash}) + '\n';
  const previousMarker = await readFile(markerPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (previousMarker !== marker) await publishFile(markerPath, marker);
  const evidence = `第${previousNumber}回の保存済み回答${answeredCurrent ? 'あり' : 'なし'}`;
  console.log(`out/${doc.title}.html　${doc.sections.length}セクション・${ids.rows.size}行・判断${doc.decisions.length}件・指摘${doc.issues.length}件　${evidence} → 第${number}回`);
  for (const d of doc.decisions) {
    if (d.options.length >= 7) console.log(`警告：判断 ${d.id} の options が${d.options.length}個あります。問いを分けてください。`);
  }
  for (const warning of saved.warnings) console.log('警告：' + warning);
}

const args = process.argv.slice(2);
try {
  if (typeof nodeModule.registerHooks !== 'function') {
    throw Error('このキットには同期モジュール解決フックが必要です。Node.js 22.15.0 以降の 22 系、または 23.5.0 以降を使用してください。');
  }
  if (args[0] === '--init' && args[1] && !args[1].startsWith('--') &&
      (args.length === 2 || (args.length === 3 && args[2] === '--with-images'))) {
    const entry = await initManuscript(args[1], args.length === 3);
    console.log(`原稿の準備ができました。${entry}`);
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    await build(path.resolve(args[0]));
  } else {
    throw Error(usage);
  }
} catch (error) {
  const location = args[0] && !args[0].startsWith('--') ? `（${path.resolve(args[0])}）` : '';
  console.error(`エラー${location}：${error.message}`);
  process.exitCode = 1;
}
