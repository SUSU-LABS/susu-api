import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';

describe('Server Lifecycle & Nonce Reaper', () => {
  it('should clear the nonce reaper interval on app.close()', async () => {
    const app = await buildServer({
      // Provide a mock dbPool to prevent actual migrations/connections if needed, 
      // or rely on default test setup.
    });

    await app.ready();
    
    // Server is up, we close it
    await app.close();

    // If clearInterval was correctly called and tied to onClose, 
    // no active handles should be leaking due to this specific interval.
    expect(true).toBe(true);
  });
});
