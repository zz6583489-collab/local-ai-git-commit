import { setTimeout as delay } from 'node:timers/promises';
import type { Settings } from '../../config/settings';
import { completionUrl } from './providerRegistry';
import { assertSafeText } from '../security/secretGuard';

export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface AiMessage {
  role: 'system' | 'user';
  content: string;
}

export class AiClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  async complete(
    messages: AiMessage[],
    settings: Settings,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    for (const message of messages) assertSafeText(message.content);
    const url = completionUrl(settings.baseUrl);
    const body: Record<string, unknown> = { model: settings.model, messages, stream: false };
    if (settings.sendTemperature) body.temperature = settings.temperature;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new AiRequestError('生成已取消。');
      const timeout = AbortSignal.timeout(settings.timeout);
      const combined = AbortSignal.any([signal, timeout]);
      try {
        const response = await this.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: combined,
          redirect: 'error',
        });
        if (!response.ok) {
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
            await delay(
              response.status === 429 ? 1000 * 2 ** attempt : 500 * 2 ** attempt,
              undefined,
              { signal },
            );
            continue;
          }
          throw new AiRequestError(httpMessage(response.status), response.status);
        }
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new AiRequestError('模型返回的内容不是有效 JSON。');
        }
        if (!isCompletion(data)) throw new AiRequestError('模型响应格式无效或内容为空。');
        if (data.choices[0].finish_reason === 'length')
          throw new AiRequestError('模型输出达到长度限制，请更换模型或缩小暂存内容。');
        return data.choices[0].message.content.trim();
      } catch (error) {
        if (signal.aborted) throw new AiRequestError('生成已取消。');
        if (timeout.aborted) throw new AiRequestError('AI 请求超时。');
        if (error instanceof AiRequestError) throw error;
        if (attempt < 2 && error instanceof TypeError) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new AiRequestError('无法连接 AI 服务，请检查地址、网络和代理设置。');
      }
    }
    throw new AiRequestError('AI 请求重试次数已用尽。');
  }
}

function isCompletion(
  value: unknown,
): value is { choices: [{ message: { content: string }; finish_reason?: string }] } {
  if (!value || typeof value !== 'object' || !('choices' in value) || !Array.isArray(value.choices))
    return false;
  const message: unknown = value.choices[0]?.message;
  return (
    !!message &&
    typeof message === 'object' &&
    'content' in message &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

function httpMessage(status: number): string {
  if (status === 401) return 'API Key 无效或已过期（401）。';
  if (status === 403) return 'API Key 无权访问当前模型（403）。';
  if (status === 404) return 'API 地址或模型不存在（404）。';
  if (status === 429) return '请求过于频繁或余额不足（429），请稍后重试。';
  if (status >= 500) return `AI 服务暂时不可用（${status}）。`;
  return `AI 请求失败（HTTP ${status}），请检查模型与服务商配置。`;
}
