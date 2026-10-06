import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from '../auth/verify'
import { supabase } from '../lib/supabase'

interface PrepareBody {
  amount: number
  currency: string
  metadata?: Record<string, unknown>
}

const PREPARE_MAX = 5
const PREPARE_WINDOW_MS = 60_000

const userPrepareCounters = new Map<string, { count: number; resetAt: number }>()

function isUserPrepareAllowed(userId: string): boolean {
  const now = Date.now()
  const entry = userPrepareCounters.get(userId)
  if (!entry || now >= entry.resetAt) {
    userPrepareCounters.set(userId, { count: 1, resetAt: now + PREPARE_WINDOW_MS })
    return true
  }
  if (entry.count >= PREPARE_MAX) {
    return false
  }
  entry.count += 1
  return true
}

async function prepareUserRateLimit(request: FastifyRequest, reply: FastifyReply) {
  const user = (request as any).user
  if (!user?.id) {
    return
  }
  if (!isUserPrepareAllowed(user.id)) {
    reply.code(429).send({ error: 'Too Many Requests', code: 'RATE_LIMITED' })
    return
  }
}

export async function transactionsRoutes(app: FastifyInstance) {
  app.post('/transactions/prepare', {
    preHandler: [requireAuth, prepareUserRateLimit]
  }, async (request: FastifyRequest<{ Body: PrepareBody }>, reply: FastifyReply) => {
    const user = (request as any).user
    const { amount, currency, metadata } = request.body

    const { data, error } = await supabase
      .from('transactions')
      .insert({
        user_id: user.id,
        amount,
        currency,
        metadata,
        status: 'prepared'
      })
      .select()
      .single()

    if (error) {
      return reply.code(500).send({ error: 'Internal error' })
    }

    return reply.send({ transaction: data })
  })

  // ... demais rotas de transactions permanecem inalteradas
}
