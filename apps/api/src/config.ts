import {z} from 'zod';

const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const configSchema = z.object({
  DEMO_MODE: z.enum(['true', 'false']).default('true'),
  CONNECTOR_MODE: z.enum(['mock', 'local']).default('mock'),
  API_PORT: positiveInt(3001),
  CORS_ORIGIN: z.string().default('*'),
  ALLOWLIST_SYSTEMS: z.string().default('PostgreSQL,MinIO'),
  ALLOWLIST_HOSTS: z.string().default('postgres'),
  ALLOWLIST_BUCKETS: z.string().default('customer-uploads,support-attachments,exports,eraseops-backups'),
  APPROVAL_TTL_MINUTES: positiveInt(15),
  DESTRUCTIVE_RATE_LIMIT: positiveInt(3),
  DESTRUCTIVE_RATE_WINDOW_SECONDS: positiveInt(60),
  ERASEROPS_PERSISTENCE: z.enum(['memory', 'postgres']).default('memory'),
  ERASEOPS_DATASET_FILE: z.string().optional(),
  DATABASE_URL: z.string().default('postgres://eraseops:eraseops_local_only@localhost:5432/eraseops'),
  MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('eraseops'),
  MINIO_SECRET_KEY: z.string().default('eraseops_local_only'),
  ERASEOPS_AI: z.enum(['auto', 'claude', 'off']).default('auto'),
  ERASEOPS_MODEL: z.string().default('claude-opus-5-5'),
});

export type EraserOpsConfig = {
  demoMode: boolean;
  connectorMode: 'mock' | 'local';
  allowlistedSystems: string[];
  allowlistedHosts: string[];
  allowlistedBuckets: string[];
  port: number;
  corsOrigin: string;
  approvalTtlMs: number;
  rateLimit: {maxAttempts: number; windowMs: number};
  persistence: 'memory' | 'postgres';
  datasetFile?: string;
  databaseUrl: string;
  minio: {endpoint: string; accessKey: string; secretKey: string};
  ai: {mode: 'auto' | 'claude' | 'off'; model: string};
};

/** Loads `.env` from the working directory when present; real environment variables always win. */
export function loadEnvFile(path = '.env') {
  try { process.loadEnvFile(path); } catch { /* no .env file is a valid configuration */ }
}

export function loadConfig(env: Record<string, string | undefined>): EraserOpsConfig {
  const parsed = configSchema.parse(env);
  if (parsed.DEMO_MODE !== 'true') throw new Error('Production execution is disabled; DEMO_MODE must be true');
  return {
    demoMode: true,
    connectorMode: parsed.CONNECTOR_MODE,
    allowlistedSystems: list(parsed.ALLOWLIST_SYSTEMS),
    allowlistedHosts: list(parsed.ALLOWLIST_HOSTS),
    allowlistedBuckets: list(parsed.ALLOWLIST_BUCKETS),
    port: parsed.API_PORT,
    corsOrigin: parsed.CORS_ORIGIN,
    approvalTtlMs: parsed.APPROVAL_TTL_MINUTES * 60_000,
    rateLimit: {maxAttempts: parsed.DESTRUCTIVE_RATE_LIMIT, windowMs: parsed.DESTRUCTIVE_RATE_WINDOW_SECONDS * 1000},
    persistence: parsed.ERASEROPS_PERSISTENCE,
    datasetFile: parsed.ERASEOPS_DATASET_FILE,
    databaseUrl: parsed.DATABASE_URL,
    minio: {endpoint: parsed.MINIO_ENDPOINT, accessKey: parsed.MINIO_ACCESS_KEY, secretKey: parsed.MINIO_SECRET_KEY},
    ai: {mode: parsed.ERASEOPS_AI, model: parsed.ERASEOPS_MODEL},
  };
}
