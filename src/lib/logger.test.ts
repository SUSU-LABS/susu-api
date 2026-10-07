import { Writable } from 'node:stream';
import pino, { type LoggerOptions } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from './logger';

describe.each(['development', 'production'])('logger redaction in %s', (nodeEnv) => {
  it('removes every configured secret from serialized output', async () => {
    const output: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    });

    const logger = pino(buildLoggerOptions(nodeEnv) as LoggerOptions, destination);
    const secrets = {
      authorization: 'Bearer authorization-value',
      cookie: 'session=cookie-value',
      apiKey: 'api-key-value',
      setCookie: 'session=set-cookie-value',
      databaseUrl: 'postgres://database-value',
      serviceRoleKey: 'service-role-value',
      nonceSecret: 'nonce-secret-value',
      s3AccessKey: 's3-access-key-value',
      s3SecretKey: 's3-secret-key-value',
      password: 'password-value',
      secret: 'secret-value',
      token: 'token-value',
      privateKey: 'private-key-value',
      nestedPassword: 'nested-password-value',
      nestedSecret: 'nested-secret-value',
      nestedToken: 'nested-token-value',
      nestedPrivateKey: 'nested-private-key-value',
      nestedAuthorization: 'nested-authorization-value',
    };

    logger.info({
      req: {
        headers: {
          authorization: secrets.authorization,
          cookie: secrets.cookie,
          'x-api-key': secrets.apiKey,
        },
      },
      res: { headers: { 'set-cookie': secrets.setCookie } },
      DATABASE_URL: secrets.databaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: secrets.serviceRoleKey,
      WALLET_NONCE_SECRET: secrets.nonceSecret,
      S3_ACCESS_KEY_ID: secrets.s3AccessKey,
      S3_SECRET_ACCESS_KEY: secrets.s3SecretKey,
      password: secrets.password,
      secret: secrets.secret,
      token: secrets.token,
      privateKey: secrets.privateKey,
      nested: {
        password: secrets.nestedPassword,
        secret: secrets.nestedSecret,
        token: secrets.nestedToken,
        privateKey: secrets.nestedPrivateKey,
        authorization: secrets.nestedAuthorization,
      },
    });
    await new Promise<void>((resolve, reject) => {
      destination.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    const serialized = output.join('');
    expect(serialized).toContain('[redacted]');
    for (const value of Object.values(secrets)) {
      expect(serialized).not.toContain(value);
    }
  });
});
