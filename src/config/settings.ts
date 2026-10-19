import * as vscode from 'vscode';
import { completionUrl, providerPreset, type ProviderId } from '../services/ai/providerRegistry';

export type OutputFormat = 'singleLine' | 'prompt';

export interface Settings {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  language: string;
  timeout: number;
  temperature: number;
  sendTemperature: boolean;
  maxDiffLength: number;
  maxContextTokens: number;
  maxSummaryCalls: number;
  autoFill: boolean;
  confirmOverwrite: boolean;
  conventionalCommits: boolean;
  customPrompt: string;
  outputFormat: OutputFormat;
  promptFile: string;
}

function between(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须在 ${min} 到 ${max} 之间。`);
  }
  return value;
}

function integerBetween(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} 必须是整数。`);
  return between(value, min, max, name);
}

export function readSettings(resource?: vscode.Uri): Settings {
  const config = vscode.workspace.getConfiguration('aiGitCommit', resource);
  const provider = config.get<string>('provider', 'custom');
  const preset = providerPreset(provider);
  if (!preset) throw new Error('服务商设置无效。');
  const baseUrl = provider === 'custom' ? config.get<string>('baseUrl', '').trim() : preset.baseUrl;
  const model = config.get<string>('model', '').trim() || preset.model;
  if (!baseUrl) throw new Error('请先配置 AI Git Commit 的 API Base URL。');
  completionUrl(baseUrl);
  if (!model) throw new Error('请先配置 AI Git Commit 的模型 ID。');
  const language = config.get<string>('language', 'zh-CN').trim();
  if (!language || language.length > 32) throw new Error('生成语言设置无效。');
  const customPrompt = config.get<string>('customPrompt', '');
  if (customPrompt.length > 8000) throw new Error('自定义 Prompt 不能超过 8000 字符。');
  const outputFormat = config.get<string>('outputFormat', 'singleLine');
  if (outputFormat !== 'singleLine' && outputFormat !== 'prompt')
    throw new Error('输出格式模式无效。');
  const promptFile = config.get<string>('promptFile', '').trim();
  if (promptFile.length > 1024 || promptFile.includes('\0'))
    throw new Error('提示词文件路径无效。');
  if (outputFormat === 'prompt' && !customPrompt.trim() && !promptFile)
    throw new Error('提示词格式模式需要配置 customPrompt 或 promptFile。');
  return {
    provider: provider as ProviderId,
    baseUrl,
    model,
    language,
    timeout: integerBetween(config.get<number>('timeout', 120000), 1000, 300000, '请求超时'),
    temperature: between(config.get<number>('temperature', 0.2), 0, 2, 'temperature'),
    sendTemperature: config.get<boolean>('sendTemperature', false),
    maxDiffLength: integerBetween(
      config.get<number>('maxDiffLength', 30000),
      2000,
      200000,
      '单次差异预算',
    ),
    maxContextTokens: integerBetween(
      config.get<number>('maxContextTokens', 16000),
      1000,
      100000,
      '上下文 Token 预算',
    ),
    maxSummaryCalls: integerBetween(config.get<number>('maxSummaryCalls', 10), 1, 30, '摘要次数'),
    autoFill: config.get<boolean>('autoFill', true),
    confirmOverwrite: config.get<boolean>('confirmOverwrite', true),
    conventionalCommits: config.get<boolean>('conventionalCommits', true),
    customPrompt,
    outputFormat,
    promptFile,
  };
}
