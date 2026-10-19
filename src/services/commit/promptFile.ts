import { open, realpath } from 'node:fs/promises';
import * as path from 'node:path';

const maxPromptFileBytes = 16 * 1024;

export async function loadFormatPrompt(
  root: string,
  fileSetting: string,
  customPrompt: string,
): Promise<string> {
  if (!fileSetting) return customPrompt.trim();
  const absolute = path.isAbsolute(fileSetting);
  const resolved = absolute ? fileSetting : path.resolve(root, fileSetting);
  if (!absolute) {
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('相对提示词文件必须位于所选仓库内。');
  }
  let content: string;
  try {
    const realFile = await realpath(resolved);
    if (!absolute) {
      const relative = path.relative(await realpath(root), realFile);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('相对提示词文件必须位于所选仓库内。');
      }
    }
    const handle = await open(realFile, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxPromptFileBytes)
        throw new Error('提示词文件必须是小于 16 KiB 的普通文本文件。');
      content = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(content, 'utf8') > maxPromptFileBytes)
        throw new Error('提示词文件必须是小于 16 KiB 的普通文本文件。');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('相对提示词文件') || error.message.startsWith('提示词文件必须'))
    )
      throw error;
    throw new Error('无法读取提示词文件，请检查所选仓库的 promptFile 路径。');
  }
  if (!content.trim()) throw new Error('提示词文件为空。');
  return [content.trim(), customPrompt.trim()].filter(Boolean).join('\n\n附加规则：\n');
}
