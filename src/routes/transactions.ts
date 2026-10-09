import { Router, Request, Response } from 'express';
import { SorobanService } from '../lib/soroban';
import { SorobanSimulationResult } from '../lib/types';

const router = Router();
const soroban = new SorobanService(process.env.SOROBAN_RPC_URL!);

enum RpcErrorKind {
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  REFUSED = 'REFUSED',
  RESTORE_REQUIRED = 'RESTORE_REQUIRED',
  TIMEOUT = 'TIMEOUT',
  TRANSPORT = 'TRANSPORT',
}

function isUpstreamFailure(err: any): boolean {
  if (!err) return false;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (err.name === 'AbortError') return true;
  if (err.code === 'SIM_TIMEOUT' || err.code === 'INVOCATION_TIMEOUT') return true;
  const msg = String(err.message ?? '');
  if (/simulated cost/.test(msg) || /transaction simulation failed/i.test(msg)) return true;
  return false;
}

router.post('/transactions', async (req: Request, res: Response) => {
  try {
    const { transaction } = req.body;

    // --- simulation step ---
    let simulation: SorobanSimulationResult;
    try {
      simulation = await soroban.simulate(transaction);
    } catch (err: any) {
      if (err?.code === 'REFUSED' || err?.kind === RpcErrorKind.REFUSED) {
        return res.status(400).json({ error: 'simulation_refused', details: err.message });
      }
      if (err?.code === 'RESTORE_REQUIRED' || err?.kind === RpcErrorKind.RESTORE_REQUIRED) {
        return res.status(402).json({ error: 'restore_required', details: err.message });
      }
      if (isUpstreamFailure(err)) {
        return res.status(502).json({
          error: 'upstream_failure',
          message: err.message ?? 'Soroban RPC simulation failed',
        });
      }
      throw err;
    }

    // ... rest of handler ...
    res.json({ simulation });
  } catch (err: any) {
    if (isUpstreamFailure(err)) {
      return res.status(503).json({
        error: 'upstream_failure',
        message: err.message ?? 'Soroban RPC invocation failed',
      });
    }
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

export default router;
