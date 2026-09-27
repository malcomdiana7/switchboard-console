import './env.js';
import { buildLlmAgentApp } from './app.js';

if (process.env.ENABLE_C_FEATURES?.toLowerCase() !== 'true') {
  console.log('C 组功能未启用，LLM Agent 不启动。');
  process.exit(0);
}

const baseUrl = process.env.LLM_BASE_URL;
const model = process.env.LLM_MODEL;
if (!baseUrl || !model) throw new Error('启用 C 组功能时必须配置 LLM_BASE_URL 和 LLM_MODEL');

const app = buildLlmAgentApp({
  baseUrl,
  model,
  apiKey: process.env.LLM_API_KEY ?? '',
});
await app.listen({ port: Number(process.env.LLM_AGENT_PORT ?? 4300), host: '0.0.0.0' });
