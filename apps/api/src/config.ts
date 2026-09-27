export interface Config {
  port: number;
  databaseUrl: string;
  gatewayUrl: string;
  agentUrl: string;
  jwtSecret: string;
  webOrigin: string;
  turnTimeoutMs: number;
  enableCFeatures: boolean;
  mediaEnabled: boolean;
  mediaDir: string;
  mediaRetentionDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string, fallback?: string) => {
    const value = env[name] ?? fallback;
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };
  const enableCFeatures = env.ENABLE_C_FEATURES?.toLowerCase() === 'true';
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    gatewayUrl: required('GATEWAY_URL', 'http://localhost:4100'),
    agentUrl: enableCFeatures
      ? required('LLM_AGENT_URL', 'http://localhost:4300')
      : required('AGENT_URL', 'http://localhost:4200'),
    jwtSecret: required('JWT_SECRET'),
    webOrigin: required('WEB_ORIGIN', 'http://localhost:5173'),
    turnTimeoutMs: Number(env.TURN_TIMEOUT_MS ?? 12000),
    enableCFeatures,
    mediaEnabled: enableCFeatures,
    mediaDir: required('MEDIA_DIR', 'media'),
    mediaRetentionDays: Number(env.MEDIA_RETENTION_DAYS ?? 30),
  };
}
