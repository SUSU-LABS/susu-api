import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Environment Variables Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('allows http:// URLs in development environment', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.STELLAR_RPC_URL = 'http://localhost:8000';

    const { parseEnv } = await import('./env');
    expect(() => parseEnv()).not.toThrow();
  });

  it('allows http:// URLs in test environment', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.STELLAR_RPC_URL = 'http://localhost:8000';

    const { parseEnv } = await import('./env');
    expect(() => parseEnv()).not.toThrow();
  });

  it('allows https:// URLs in production environment', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://supabase.example.com';
    process.env.STELLAR_RPC_URL = 'https://stellar.example.com';

    const { parseEnv } = await import('./env');
    expect(() => parseEnv()).not.toThrow();
  });

  it('rejects http:// SUPABASE_URL in production environment', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'http://supabase.example.com';
    process.env.STELLAR_RPC_URL = 'https://stellar.example.com';

    const { parseEnv } = await import('./env');
    expect(() => parseEnv()).toThrow('Invalid environment variables');
  });

  it('rejects http:// STELLAR_RPC_URL in production environment', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://supabase.example.com';
    process.env.STELLAR_RPC_URL = 'http://stellar.example.com';

    const { parseEnv } = await import('./env');
    expect(() => parseEnv()).toThrow('Invalid environment variables');
  });
});
