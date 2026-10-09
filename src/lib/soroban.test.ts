import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanService } from './soroban';

describe('SorobanService', () => {
  let service: SorobanService;

  beforeEach(() => {
    service = new SorobanService('http://localhost:8000/simulate', { simulationTimeoutMs: 50 });
  });

  it('returns simulation result on success', async () => {
    vi.spyOn(service['rpcServer'], 'simulateTransaction').mockResolvedValue({ status: 'success' } as any);
    const result = await service.simulate('fake-tx');
    expect(result).toEqual({ status: 'success' });
  });

  it('throws SIM_TIMEOUT when RPC takes longer than the configured timeout', async () => {
    vi.spyOn(service['rpcServer'], 'simulateTransaction').mockImplementation(
      () => new Promise(() => {}) // never resolves
    );
    await expect(service.simulate('fake-tx')).rejects.toThrow('RPC simulation timed out');
    await expect(service.simulate('fake-tx')).rejects.toMatchObject({ code: 'SIM_TIMEOUT' });
  });

  it('does not interfere with REFUSED / RESTORE_REQUIRED semantics', async () => {
    vi.spyOn(service['rpcServer'], 'simulateTransaction').mockRejectedValue(
      Object.assign(new Error('refused'), { code: 'REFUSED' })
    );
    await expect(service.simulate('fake-tx')).rejects.toMatchObject({ code: 'REFUSED' });
  });
});
