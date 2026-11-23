import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function matchesExisting(file, contents) {
  try {
    if ((await readFile(file)).equals(contents)) return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (!['EISDIR', 'EPERM'].includes(error.code)) throw error;
  }
  throw Error(`ひな形の作成先に異なる内容の「${file}」があります。元のファイルを残して、別の作業フォルダを指定してください。`);
}

/** 指定先に原稿の初期ファイルを作る。同一内容は再利用し、編集済みファイルは上書きしない。 */
export async function initManuscript(folder, withImages) {
  // ビルドの入口は最後に置く。中断後の再実行でも、先にそろった同一素材を再利用できる。
  const names = withImages ? ['settings.png', 'section.mjs', 'content.mjs'] : ['content.mjs'];
  const template = fileURLToPath(new URL(`../templates/${withImages ? 'with-images' : 'text-only'}/`, import.meta.url));
  const pending = [];
  // 先に全衝突を調べる。編集済みの原稿を見つけてから画像だけが残ることを防ぐ。
  for (const name of names) {
    const source = path.join(template, name);
    const contents = await readFile(source);
    const file = path.resolve(folder, name);
    if (!await matchesExisting(file, contents)) pending.push({source, file, contents});
  }
  await mkdir(folder, {recursive: true});
  for (const {source, file, contents} of pending) {
    try {
      await copyFile(source, file, constants.COPYFILE_EXCL);
    } catch (error) {
      // 同時に開始したもう一方が先に作っていても、同じひな形ならそのまま使える。
      if (error.code !== 'EEXIST' || !await matchesExisting(file, contents)) throw error;
    }
  }
  return path.resolve(folder, 'content.mjs');
}
