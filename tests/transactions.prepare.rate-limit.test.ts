import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { transactionsRoutes } from '../src/routes/transactions'
import * as verifyModule from '../src/auth/verify'

describe('POST /transactions/prepare rate limiting', () => {
  let app

  beforeEach(async () => {
    app = Fastify()
    vi.spyOn(verifyModule, 'verifyToken').mockImplementation(async (req) => {
      const auth = req.headers.authorization || ''
      const token = auth.replace('Bearer ', '')
      if (token === 'valid-session') {
        ;(req as any).user = { id: 'user-123' }
        return true
      }
      ;(req as any).user = undefined
      return false
    })
    await app.register(transactionsRoutes)
    await app.ready()
  })

  it('blocks rotating bearer tokens with coarse IP budget and limits verifyToken calls', async () => {
    const N = 5
    for (let i = 0; i < N; i++) {
      await app.inject({
        method: 'POST',
        url: '/transactions/prepare',
        headers: { authorization: `Bearer random-${i}` },
        payload: { amount: 1, currency: 'USD' }
      })
    }
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/prepare',
      headers: { authorization: 'Bearer random-extra' },
      payload: { amount: 1, currency: 'USD' }
    })
    expect([429, 401]).toContain(res.statusCode)
    expect(verifyModule.verifyToken).toHaveBeenCalledTimes(N)
  })

  it('allows a valid session to use its per-user budget', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/transactions/prepare',
        headers: { authorization: 'Bearer valid-session' },
        payload: { amount: 10, currency: 'USD' }
      })
      expect(res.statusCode).not.toBe(429)
    }
    const res = await app.inject({
      method: 'POST',
      url: '/transactions/prepare',
      headers: { authorization: 'Bearer valid-session' },
      payload: { amount: 10, currency: 'USD' }
    })
    expect(res.statusCode).toBe(429)
  })
})
