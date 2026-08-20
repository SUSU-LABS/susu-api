import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { GroupReadModel, PageResult } from '../db/groups';
import { invalidRequest } from './errors';

/**
 * Read-only group endpoints.
 *
 * Every response here is a report of what the contracts did, read from the
 * indexer's tables. Nothing in this file writes, and nothing decides an amount,
 * a recipient, or eligibility.
 *
 * The chain is authoritative, so these responses can be stale: the index trails
 * the chain by up to one scheduled indexing run. The short `cache-control` below
 * acknowledges the same thing, and a client that needs certainty reads the
 * contract.
 */

/** Default page size when a request does not ask for one. */
export const DEFAULT_LIMIT = 20;

/** Largest page the API will serve, regardless of what is asked for. */
export const MAX_LIMIT = 100;

/**
 * Furthest offset the API will serve.
 *
 * Deep offsets make the database walk every skipped row, so a large one is a
 * cheap way to request an expensive query. A client needing to page beyond this
 * should narrow its filter instead.
 */
export const MAX_OFFSET = 10_000;

/**
 * Chain-derived data is public and changes only when the indexer runs, so it is
 * cacheable — briefly. The window is deliberately short: a client usually looks
 * immediately after sending a transaction, and a cached "no contribution yet"
 * is precisely the wrong answer to serve at that moment.
 */
const CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=25';

/** A Soroban contract address: `C` followed by 55 base-32 characters. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * A Soroban address.
 *
 * `G` is a classic account and `C` a contract, and both are valid members,
 * creators and recipients: a wallet-contract member is a `C` address, so a
 * `G`-only pattern would reject real groups.
 */
const ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;

const contractIdParams = z.object({
  contractId: z.string().regex(CONTRACT_ID_PATTERN, 'must be a Soroban contract address'),
});

const paginationFields = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
};

const listGroupsQuery = z.object({
  status: z.enum(['open', 'active', 'completed']).optional(),
  creator: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar address').optional(),
  member: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar address').optional(),
  ...paginationFields,
});

const pageQuery = z.object(paginationFields);

export type GroupRoutesOptions = {
  readModel: GroupReadModel;
};

function groupNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'group_not_found' });
}

function envelope<T>(result: PageResult<T>, limit: number, offset: number) {
  return {
    data: result.items,
    page: { limit, offset, hasMore: result.hasMore },
  };
}

/**
 * Answers whether a group is known, reporting it missing when it is not.
 *
 * Sub-resources read from tables that cascade on the group, so an unknown group
 * and a group with nothing in it look identical in the data. Asking first keeps
 * "this group has no payouts yet" distinct from "there is no such group", which
 * are very different answers to a client.
 */
async function requireGroup(
  readModel: GroupReadModel,
  contractId: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (await readModel.groupExists(contractId)) return true;
  groupNotFound(reply);
  return false;
}

export async function groupRoutes(
  app: FastifyInstance,
  options: GroupRoutesOptions,
): Promise<void> {
  const { readModel } = options;

  app.get('/groups', async (request, reply) => {
    const parsed = listGroupsQuery.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const { limit, offset, status, creator, member } = parsed.data;
    // Built explicitly so that an absent filter stays absent rather than being
    // passed as `undefined` and relying on the read model to ignore it.
    const result = await readModel.listGroups({
      limit,
      offset,
      ...(status === undefined ? {} : { status }),
      ...(creator === undefined ? {} : { creator }),
      ...(member === undefined ? {} : { member }),
    });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId', async (request, reply) => {
    const parsed = contractIdParams.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const group = await readModel.getGroup(parsed.data.contractId);
    if (group === undefined) return groupNotFound(reply);

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send({ data: group });
  });

  app.get('/groups/:contractId/contributions', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listContributions(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId/payouts', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listPayouts(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId/activity', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listActivity(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });
}
