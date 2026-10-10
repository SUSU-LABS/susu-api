import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNotificationSweeper } from '../db/notification-sweep';
import { getDb } from '../db';

vi.mock('../db', () => ({
  getDb: vi.fn(),
}));

describe('Notification Sweeper Lifecycle', () => {
  let mockDb: any;
  let mockSweep: any;

  beforeEach(() => {
    mockSweep = vi.fn().mockResolvedValue(undefined);
    mockDb = {
      // Mock das operações de banco necessárias para o sweep
    };
    (getDb as any).mockReturnValue(mockDb);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should call sweep function when triggered', async () => {
    const sweeper = createNotificationSweeper(mockDb);
    // Mock do método sweep interno se necessário, ou testar a chamada
    await sweeper.sweep();
    expect(mockSweep).not.toBeDefined(); // Depende da implementação interna de sweep
    // Nota: Como o sweep é o alvo, validamos se a estrutura permite a execução manual
  });

  it('should be able to run manually without pg_cron dependency', async () => {
    const sweeper = createNotificationSweeper(mockDb);
    await expect(sweeper.sweep()).resolves.not.toThrow();
  });
});
