import * as vscode from 'vscode';
import { CommitCommands } from './commands/generateCommit';
import { ConfigCommands } from './commands/configCommands';
import { ApiKeyManager } from './services/ai/apiKeyManager';

let commitCommands: CommitCommands | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('AI Git Commit');
  const log = (event: string): void => output.appendLine(`[${new Date().toISOString()}] ${event}`);
  const keys = new ApiKeyManager(context.secrets);
  commitCommands = new CommitCommands(keys, log);
  const config = new ConfigCommands(keys, log);
  const showError = (error: unknown): void => {
    // HTTP 层只抛出固定的中文原因；不记录异常对象、密钥、请求体或 Diff。
    log('操作失败');
    void vscode.window.showErrorMessage(
      `AI Git Commit：${error instanceof Error ? error.message : '操作失败。'}`,
    );
  };
  const register = (name: string, fn: (...args: unknown[]) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(`aiGitCommit.${name}`, (...args: unknown[]) =>
        fn(...args).catch(showError),
      ),
    );
  };
  register('generate', (arg) => commitCommands!.generate(arg));
  register('regenerate', (arg) => commitCommands!.generate(arg));
  register('copy', (arg) => commitCommands!.copy(arg));
  register('cancel', (arg) => commitCommands!.cancel(arg));
  register('setApiKey', () => config.setApiKey());
  register('deleteApiKey', () => config.deleteApiKey());
  register('checkApiKey', () => config.checkApiKey());
  register('selectProvider', () => config.selectProvider());
  register('configureModel', () => config.configureModel());
  register('testConnection', () => config.testConnection());
  register('showLogs', async () => output.show());
  context.subscriptions.push(output);
  log('扩展已激活');
}

export function deactivate(): void {
  commitCommands?.dispose();
  commitCommands = undefined;
}
