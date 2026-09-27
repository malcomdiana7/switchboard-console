import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret-that-is-long-enough',
  GATEWAY_URL: 'http://gateway',
  AGENT_URL: 'http://mock-agent',
  LLM_AGENT_URL: 'http://llm-agent',
};

describe('C 组功能开关', () => {
  it('关闭时使用模拟 Agent 且不启用媒体归档', () => {
    const config = loadConfig({ ...baseEnv, ENABLE_C_FEATURES: 'false' });
    expect(config.enableCFeatures).toBe(false);
    expect(config.agentUrl).toBe('http://mock-agent');
    expect(config.mediaEnabled).toBe(false);
  });

  it('开启时切换到 LLM Agent 并启用媒体归档', () => {
    const config = loadConfig({ ...baseEnv, ENABLE_C_FEATURES: 'true' });
    expect(config.enableCFeatures).toBe(true);
    expect(config.agentUrl).toBe('http://llm-agent');
    expect(config.mediaEnabled).toBe(true);
  });
});
