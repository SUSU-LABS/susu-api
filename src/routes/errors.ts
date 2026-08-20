/**
 * Shared response shapes for route-level rejections.
 *
 * These live in one place because the browser parses them. Two route files that
 * each define their own `invalid_request` shape will drift, and the drift shows
 * up as a client that handles validation errors for one endpoint and not
 * another.
 */
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/**
 * A 400 carrying per-field detail.
 *
 * Field paths and messages are the only thing echoed. Zod's issue objects also
 * carry the received value in some cases, and a validation error that quotes the
 * offending input back is a small information leak in the best case and a
 * log-poisoning vector in the worst.
 */
export function invalidRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: 'invalid_request',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  });
}
