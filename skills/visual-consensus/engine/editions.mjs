import { createHash } from 'node:crypto';
import { signature } from './model.mjs';

const hash = value => createHash('sha256').update(signature(value)).digest('hex');
const space = text => text.replace(/[ \t\r\n\f]+/g, ' ');
const block = '(?:address|article|aside|blockquote|br|caption|dd|details|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|section|summary|table|tbody|td|th|thead|tr|ul)';
const blockStart = new RegExp('^</?' + block + '(?:\\s|/?>)', 'i');

// 通常の本文では改行とインデントは折り畳まれる。整形済み本文と属性の引用符内はそのまま比べる。
function htmlText(html) {
  const tokens = html.match(/<!--[\s\S]*?-->|<(pre|textarea|script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gi) ?? [];
  const pieces = tokens.filter(part => !part.startsWith('<!--'));
  return pieces.map((part, i) => {
    if (/^<(pre|textarea|script|style)\b/i.test(part)) return part;
    if (/^<\/?[A-Za-z]/.test(part)) {
      return part.split(/("[^"]*"|'[^']*')/g).map((chunk, n) => n % 2 ? chunk : space(chunk).replace(/ *= */g, '=')).join('').replace(/ +\/?>$/, end => end.trim());
    }
    let value = space(part);
    if (!i || blockStart.test(pieces[i - 1])) value = value.replace(/^ +/, '');
    if (i === pieces.length - 1 || blockStart.test(pieces[i + 1])) value = value.replace(/ +$/, '');
    return value;
  }).join('');
}

function normalized(value, field) {
  if (typeof value === 'string') return field === 'html' ? htmlText(value) : space(value).trim();
  if (Array.isArray(value)) return value.map(item => normalized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalized(item, key)]));
  return value;
}

export function manuscriptHash(doc, assets, style) {
  return hash({doc: normalized(doc), assets, style: style.trim().replace(/\r\n/g, '\n')});
}

/** 現在ある返事ごとに [その文を書いた版, 本文のハッシュ] を返す。旧記録からも同じ版を引き継ぐ。 */
export function currentReplies(replies, last, number) {
  return Object.fromEntries(Object.entries(replies ?? {}).map(([key, reply]) => {
    const digest = hash(normalized(reply)).slice(0, 24);
    const prior = last?.replies?.[key] ?? last?.history?.items?.['reply/' + key]?.at(-1);
    const posted = prior?.[1] === digest ? prior[0] : number;
    return [key, [posted, digest]];
  }));
}
