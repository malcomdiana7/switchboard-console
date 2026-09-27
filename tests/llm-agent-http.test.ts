import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLlmAgentApp } from '../apps/llm-agent/src/app.js';

const tools = [
  {
    name: 'get_recent_messages',
    description: '读取消息',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: ['limit'],
    },
  },
  {
    name: 'send_message',
    description: '发送消息',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: '移除用户',
    input_schema: {
      type: 'object',
      properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: '结束运行',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
];

describe('OpenAI 兼容 LLM Agent HTTP 接口', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('把 OpenAI tool_call 转换为题目约定的单个 tool_use', async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'send_message',
                      arguments: '{"text":"你好","idempotency_key":"k-1"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', upstream);
    const app = buildLlmAgentApp({
      baseUrl: 'http://llm.test/v1',
      apiKey: 'secret',
      model: 'test-model',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/agent/turn',
      payload: {
        runId: 'run-1',
        tools,
        messages: [{ role: 'user', content: [{ type: 'text', text: '{"groupId":"g1"}' }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'send_message',
          input: { text: '你好', idempotency_key: 'k-1' },
        },
      ],
    });
    expect(upstream).toHaveBeenCalledOnce();
    await app.close();
  });

  it('通过 OpenAI JSON 输出提供严格的审计结论', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"pass","reason":"内容安全"}' } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const app = buildLlmAgentApp({
      baseUrl: 'http://llm.test/v1',
      apiKey: 'secret',
      model: 'test-model',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/audit',
      payload: { groupId: 'g1', text: '你好' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verdict: 'pass', reason: '内容安全' });
    await app.close();
  });
});
