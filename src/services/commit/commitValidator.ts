import type { OutputFormat } from '../../config/settings';

const allowed = 'feat|fix|refactor|perf|docs|style|test|chore|build|ci|revert';
const pattern = new RegExp(`^(?:${allowed})(?:\\([a-zA-Z0-9._/-]+\\))?: [^\\s].{3,100}$`, 'u');
const headerPattern = new RegExp(`^(?:${allowed})\\([a-zA-Z0-9._/-]+\\): [^\\s].+$`, 'u');

export function validateCommitMessage(
  message: string,
  conventional: boolean,
  outputFormat: OutputFormat = 'singleLine',
): string | undefined {
  const trimmed = message.trim();
  if (!trimmed) return '提交信息不能为空。';
  if (/^(`|#|>|- )/.test(trimmed) || trimmed.includes('```'))
    return '提交信息不能包含 Markdown 标题、引用或代码块。';
  if (outputFormat === 'singleLine') {
    if (trimmed.includes('\n') || trimmed.includes('\r')) return '提交信息必须是非空的单行文本。';
    if (trimmed.length > 120) return '提交信息不能超过 120 字符。';
    if (conventional && !pattern.test(trimmed)) return '提交信息不符合 Conventional Commits 格式。';
    return undefined;
  }
  if (trimmed.length > 4000) return '提示词格式的提交信息不能超过 4000 字符。';
  const lines = trimmed.split(/\r?\n/);
  if (conventional) {
    if (lines[0].length > 80) return '提交信息第一行不能超过 80 字符。';
    if (!headerPattern.test(lines[0])) return '第一行必须符合 type(scope): 描述格式。';
    if (lines.length > 1 && lines[1] !== '') return '第一行与正文之间必须空一行。';
    if (lines.length > 2 && !lines.slice(2).some((line) => line.trim()))
      return '提交信息正文不能为空。';
  }
  return undefined;
}
