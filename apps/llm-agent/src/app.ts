import Fastify from 'fastify';

export interface LlmAgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type AgentBlock = Record<string, any>;
type AgentMessage = { role: 'user' | 'assistant'; content: AgentBlock[] };

const expectedTools = ['finish', 'get_recent_messages', 'kick_user', 'send_message'];

export function buildLlmAgentApp(config: LlmAgentConfig) {
  const app = Fastify({ logger: false });

  app.post('/agent/turn', async (request, reply) => {
    const body = request.body as { runId?: string; tools?: any[]; messages?: AgentMessage[] };
    const requestTools = body.tools ?? [];
    const names = requestTools.map((tool) => tool.name).sort();
    if (!body.runId || !body.messages || JSON.stringify(names) !== JSON.stringify(expectedTools)) {
      return reply.code(400).send({ code: 'TOOLS_INVALID' });
    }

    const response = await callOpenAi(config, {
      model: config.model,
      messages: [
        {
          role: 'system',
          content:
            '你是群组自动应答 Agent。只通过提供的工具读取或改变外部状态。任务完成时调用 finish；不要同时调用多个工具。',
        },
        ...toOpenAiMessages(body.messages),
      ],
      tools: requestTools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });

    const message = response?.choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    if (call?.function) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        input = {};
      }
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input,
          },
        ],
      };
    }
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: String(message?.content ?? '') }],
    };
  });

  app.post('/agent/audit', async (request) => {
    const body = request.body as { text?: string; groupId?: string };
    const response = await callOpenAi(config, {
      model: config.model,
      messages: [
        {
          role: 'system',
          content:
            '你是严格的群组操作审计器。判断内容是否安全、合规且与群组操作相关。只输出 JSON：{"verdict":"pass"或"fail","reason":"简短原因"}。',
        },
        { role: 'user', content: JSON.stringify(body) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    const content = response?.choices?.[0]?.message?.content;
    const result = JSON.parse(content);
    if (!['pass', 'fail'].includes(result.verdict) || typeof result.reason !== 'string') {
      throw new Error('LLM returned an invalid audit verdict');
    }
    return result;
  });

  return app;
}

async function callOpenAi(config: LlmAgentConfig, body: unknown): Promise<any> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`LLM upstream ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function toOpenAiMessages(messages: AgentMessage[]): any[] {
  const namesByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') namesByCallId.set(block.id, block.name);
    }
  }
  return messages.flatMap((message) => {
    const text = message.content.find((block) => block.type === 'text');
    if (text)
      return [{ role: message.role === 'assistant' ? 'assistant' : 'user', content: text.text }];
    const use = message.content.find((block) => block.type === 'tool_use');
    if (use)
      return [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: use.id,
              type: 'function',
              function: { name: use.name, arguments: JSON.stringify(use.input) },
            },
          ],
        },
      ];
    const result = message.content.find((block) => block.type === 'tool_result');
    if (result)
      return [
        {
          role: 'tool',
          tool_call_id: result.tool_use_id,
          name: namesByCallId.get(result.tool_use_id),
          content: result.content,
        },
      ];
    return [];
  });
}
