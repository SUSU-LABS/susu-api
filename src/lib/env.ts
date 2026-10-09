import { z } from 'zod';

const isProduction = process.env.NODE_ENV === 'production';

const urlSchema = z.string().url().refine((url) => {
  if (isProduction) {
    return url.startsWith('https://');
  }
  return true;
}, {
  message: 'URL must use HTTPS in production',
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000'),
  SUPABASE_URL: urlSchema,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  STELLAR_RPC_URL: urlSchema,
});

export function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:', result.error.format());
    throw new Error('Invalid environment variables');
  }

  return result.data;
}

export const env = parseEnv();
