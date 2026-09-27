import './env.js';
import Fastify from 'fastify';
const app = Fastify({ logger: true });
const modes = new Map<string, { mode: string; turn: number }>();
app.post('/agent/turn', (req, reply) => {
  const b = req.body as any;
  if (!Array.isArray(b.tools) || b.tools.length !== 4)
    return reply.code(400).send({ code: 'TOOLS_INVALID' });
  const state = modes.get(b.runId) ?? { mode: 'normal', turn: 0 };
  state.turn++;
  modes.set(b.runId, state);
  if (state.mode === 'bad_then_unknown' && state.turn === 1) {
    reply.type('text/plain');
    return '```json\n{"bad":true}\n```';
  }
  if (state.mode === 'bad_then_unknown' && state.turn === 2)
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'unknown-1', name: 'not_a_tool', input: {} }],
    };
  const results = b.messages
    .flatMap((m: any) => m.content ?? [])
    .filter((x: any) => x.type === 'tool_result');
  if (!results.length)
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: `recent-${state.turn}`,
          name: 'get_recent_messages',
          input: { limit: 10 },
        },
      ],
    };
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: `finish-${state.turn}`,
        name: 'finish',
        input: { summary: 'Processed new group messages' },
      },
    ],
  };
});
app.post('/agent/audit', () => ({ verdict: 'pass', reason: 'Mock policy allows this action' }));
app.post('/__control/mode', (req) => {
  const b = req.body as any;
  modes.set(b.runId, { mode: b.mode, turn: 0 });
  return { ok: true };
});
await app.listen({ port: Number(process.env.AGENT_MOCK_PORT ?? 4200), host: '0.0.0.0' });
