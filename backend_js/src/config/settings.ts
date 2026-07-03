import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root of backend_js or parent
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const parseList = (val: unknown): string[] => {
  if (typeof val !== 'string') return [];
  const normalized = val.trim();
  if (!normalized) return [];
  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      // Fallback to split if JSON parse fails
    }
  }
  return normalized.split(',').map((item) => item.trim()).filter(Boolean);
};

const parseBool = (val: unknown): boolean => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return ['true', '1', 'yes', 'on', 'dev', 'development', 'debug'].includes(normalized);
  }
  return false;
};

const baseSchema = z.object({
  project_name: z.string().default('SaaS Chat Automation Platform'),
  app_version: z.string().default('0.1.0'),
  environment: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  api_v1_prefix: z.string().default('/api/v1'),
  debug: z.preprocess(parseBool, z.boolean().default(false)),
  log_level: z.enum(['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG']).default('INFO'),
  docs_enabled: z.preprocess(parseBool, z.boolean().default(true)),
  secret_key: z.string().min(32, { message: 'secret_key must be at least 32 characters long' }),
  access_token_expire_minutes: z.preprocess((v) => Number(v) || 60, z.number().default(60)),
  refresh_token_expire_days: z.preprocess((v) => Number(v) || 14, z.number().default(14)),
  cors_origins: z.preprocess(parseList, z.array(z.string()).default(['http://localhost:5173', 'http://127.0.0.1:5173'])),
  allowed_hosts: z.preprocess(parseList, z.array(z.string()).default(['*'])),

  // Database
  mysql_user: z.string().default('app'),
  mysql_password: z.string().default('app'),
  mysql_host: z.string().default('mysql'),
  mysql_port: z.preprocess((v) => Number(v) || 3306, z.number().default(3306)),
  mysql_database: z.string().default('automation'),
  database_url: z.string().optional(),

  // Redis & Queue
  redis_host: z.string().default('redis'),
  redis_port: z.preprocess((v) => Number(v) || 6379, z.number().default(6379)),
  redis_db: z.preprocess((v) => Number(v) || 0, z.number().default(0)),
  redis_url: z.string().optional(),
  celery_task_always_eager: z.preprocess(parseBool, z.boolean().default(false)),

  // Integrations
  facebook_app_id: z.string().optional().nullable(),
  facebook_app_secret: z.string().default(''),
  facebook_graph_api_version: z.string().default('v23.0'),
  facebook_graph_api_base_url: z.string().default('https://graph.facebook.com'),
  facebook_oauth_redirect_uri: z.string().default('http://localhost:5173/connections/facebook/callback'),
  whatsapp_graph_api_base_url: z.string().default('https://graph.facebook.com'),
  whatsapp_graph_api_version: z.string().default('v23.0'),
  whatsapp_verify_signature: z.preprocess(parseBool, z.boolean().default(true)),

  openai_api_key: z.string().default(''),
  llm_default_provider: z.string().default('internal'),
  llm_default_model: z.string().default('internal-reply-model-v1'),

  owner_email: z.string().default('admin@khubsoja.com'),
  owner_password: z.string().default('12331233'),
  owner_full_name: z.string().default('System Owner'),
});

const settingsSchema = baseSchema.refine((data) => {
  if (data.environment === 'production') {
    if (data.debug) return false;
    if (data.secret_key.startsWith('change-this')) return false;
    if (data.allowed_hosts.includes('*')) return false;
    if (data.cors_origins.includes('*')) return false;
    if (data.owner_password === '12331233') return false;
  }
  return true;
}, {
  message: 'Invalid settings for production environment (e.g. debug must be false, secret_key must be customized, allowed_hosts/cors_origins cannot be wildcard)',
});

export type Settings = z.infer<typeof settingsSchema>;

// Resolve computed properties
export class SafeSettings {
  private config: Settings;

  constructor() {
    // Collect env inputs mapping snake_case in process.env to the config schema fields
    const rawEnv: Record<string, unknown> = {};
    for (const key of Object.keys(baseSchema.shape)) {
      rawEnv[key] = process.env[key.toUpperCase()] || process.env[key];
    }
    
    // Fallback if secret_key isn't provided (for dev convenience only)
    if (!rawEnv.secret_key && process.env.NODE_ENV !== 'production') {
      rawEnv.secret_key = 'temporary-development-secret-key-that-is-long-enough';
    }

    const parsed = settingsSchema.safeParse(rawEnv);
    if (!parsed.success) {
      console.error('❌ Configuration validation error:', parsed.error.format());
      process.exit(1);
    }
    this.config = parsed.data;
  }

  get project_name() { return this.config.project_name; }
  get app_version() { return this.config.app_version; }
  get environment() { return this.config.environment; }
  get api_v1_prefix() { return this.config.api_v1_prefix; }
  get debug() { return this.config.debug; }
  get log_level() { return this.config.log_level; }
  get docs_enabled() { return this.config.docs_enabled; }
  get secret_key() { return this.config.secret_key; }
  get access_token_expire_minutes() { return this.config.access_token_expire_minutes; }
  get refresh_token_expire_days() { return this.config.refresh_token_expire_days; }
  get cors_origins() { return this.config.cors_origins; }
  get allowed_hosts() { return this.config.allowed_hosts; }
  
  get database_url(): string {
    if (this.config.database_url) return this.config.database_url;
    // Format connection string for Prisma: mysql://user:password@host:port/database
    return `mysql://${this.config.mysql_user}:${this.config.mysql_password}@${this.config.mysql_host}:${this.config.mysql_port}/${this.config.mysql_database}`;
  }

  get redis_url(): string {
    if (this.config.redis_url) return this.config.redis_url;
    return `redis://${this.config.redis_host}:${this.config.redis_port}/${this.config.redis_db}`;
  }

  get celery_task_always_eager() { return this.config.celery_task_always_eager; }
  get facebook_app_id() { return this.config.facebook_app_id; }
  get facebook_app_secret() { return this.config.facebook_app_secret; }
  get facebook_graph_api_version() { return this.config.facebook_graph_api_version; }
  get facebook_graph_api_base_url() { return this.config.facebook_graph_api_base_url; }
  get facebook_oauth_redirect_uri() { return this.config.facebook_oauth_redirect_uri; }
  get whatsapp_graph_api_base_url() { return this.config.whatsapp_graph_api_base_url; }
  get whatsapp_graph_api_version() { return this.config.whatsapp_graph_api_version; }
  get whatsapp_verify_signature() { return this.config.whatsapp_verify_signature; }
  get openai_api_key() { return this.config.openai_api_key; }
  get llm_default_provider() { return this.config.llm_default_provider; }
  get llm_default_model() { return this.config.llm_default_model; }
  get owner_email() { return this.config.owner_email; }
  get owner_password() { return this.config.owner_password; }
  get owner_full_name() { return this.config.owner_full_name; }

  safeDump(): Partial<Settings> {
    const dumped = { ...this.config };
    // Exclude secrets
    delete (dumped as any).secret_key;
    delete (dumped as any).mysql_password;
    delete (dumped as any).database_url;
    delete (dumped as any).redis_url;
    delete (dumped as any).facebook_app_secret;
    delete (dumped as any).openai_api_key;
    delete (dumped as any).owner_password;
    return dumped;
  }
}

let settings: SafeSettings;

export const getSettings = () => {
  if (!settings) {
    settings = new SafeSettings();
  }
  return settings;
};
