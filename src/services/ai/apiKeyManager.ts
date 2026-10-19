import type * as vscode from 'vscode';
import type { ProviderId } from './providerRegistry';

export class ApiKeyManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(provider: ProviderId): string {
    return provider === 'custom' ? 'aiGitCommit.apiKey' : `aiGitCommit.apiKey.${provider}`;
  }

  async get(provider: ProviderId): Promise<string | undefined> {
    try {
      return await this.secrets.get(this.key(provider));
    } catch {
      throw new Error('读取 API Key 失败，请检查 VS Code 密钥存储。');
    }
  }

  async has(provider: ProviderId): Promise<boolean> {
    return Boolean(await this.get(provider));
  }

  async set(provider: ProviderId, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error('API Key 不能为空或包含换行。');
    try {
      await this.secrets.store(this.key(provider), trimmed);
    } catch {
      throw new Error('保存 API Key 失败，请检查 VS Code 密钥存储。');
    }
  }

  async delete(provider: ProviderId): Promise<void> {
    try {
      await this.secrets.delete(this.key(provider));
    } catch {
      throw new Error('删除 API Key 失败，请检查 VS Code 密钥存储。');
    }
  }
}
