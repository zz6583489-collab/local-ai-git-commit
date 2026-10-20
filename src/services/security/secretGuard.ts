import * as path from 'node:path';
import type { StagedDiff } from '../../types/git';

export class SensitiveContentError extends Error {
  constructor() {
    super('检测到可能包含凭据的文件或内容，已停止向 AI 服务发送变更。请先移除密钥或缩小变更范围。');
  }
}

const knownSecrets = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const assignment =
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|authorization)\b["']?\s*[:=]\s*["']?([^\s'",;]{20,})/gi;
const placeholder = /^(?:YOUR_|EXAMPLE_|PLACEHOLDER|DUMMY|TEST_|MOCK_|\$\{|<)/i;

export function assertSafePath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = path.posix.basename(normalized);
  if (/(?:^|\/)(?:\.aws\/credentials|\.docker\/config\.json|\.kube\/config)$/.test(normalized))
    throw new SensitiveContentError();
  if (/^\.env(?:\..+)?$/.test(name) && !/\.env\..*?(?:example|sample|template|dist)$/.test(name))
    throw new SensitiveContentError();
  if (/^(?:\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(name))
    throw new SensitiveContentError();
  if (/\.(?:pem|key|p12|pfx)$/.test(name)) throw new SensitiveContentError();
  if (
    /^(?:credentials|secrets|service[-_]?account)(?:\.[^.]+)?\.(?:json|ya?ml|toml|ini|txt)$/.test(
      name,
    )
  )
    throw new SensitiveContentError();
}

export function assertSafeText(content: string): void {
  for (const pattern of knownSecrets) {
    if (pattern.test(content)) throw new SensitiveContentError();
  }
  assignment.lastIndex = 0;
  for (const match of content.matchAll(assignment)) {
    if (!placeholder.test(match[1])) throw new SensitiveContentError();
  }
}

export function assertSafeDiff(diff: StagedDiff): void {
  for (const file of diff.files) {
    assertSafePath(file.path);
    if (file.oldPath) assertSafePath(file.oldPath);
    assertSafeText(file.patch);
  }
}
