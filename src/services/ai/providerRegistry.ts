export type ProviderId = 'openai' | 'deepseek' | 'qwen' | 'siliconflow' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
}

export const providers: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  },
  {
    id: 'qwen',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: '' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
];

export function providerPreset(id: string): ProviderPreset | undefined {
  return providers.find((item) => item.id === id);
}

export function completionUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('API Base URL 格式无效。');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('API Base URL 必须使用 HTTPS（本机地址允许 HTTP）。');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API Base URL 不允许包含凭据、查询参数或片段。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.toString();
}
