import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { store } from '../store';

export async function inviteRoutes(app: FastifyInstance) {
  app.post(
    '/groups/:groupContractId/join',
    {
      schema: {
        params: z.object({
          groupContractId: z.string().toLowerCase().transform((val) => `0x${val.replace('0x', '')}`),
        }),
        body: z.object({
          code: z.string(),
        }),
      },
    },
    async (request: FastifyRequest<{ Params: { groupContractId: string }; Body: { code: string } }>, reply: FastifyReply) => {
      const { groupContractId } = request.params;
      const { code } = request.body;

      // 1. Buscar o convite primeiro sem realizar o claim (read-only)
      const invite = await store.getInviteByCode(code);

      if (!invite) {
        return reply.status(404).send({ error: 'invite_not_found' });
      }

      // 2. Validar se o convite pertence ao grupo solicitado antes de gastar o uso
      // Se o convite for para um grupo específico (invite.groupContractId !== null)
      // ele deve coincidir com o groupContractId da URL.
      if (invite.groupContractId !== null && invite.groupContractId.toLowerCase() !== groupContractId.toLowerCase()) {
        return reply.status(404).send({ error: 'invite_not_found' });
      }

      // 3. Verificar se ainda há usos disponíveis
      if (invite.uses <= 0) {
        return reply.status(400).send({ error: 'invite_exhausted' });
      }

      // 4. Realizar o claim (escrita atômica)
      const result = await store.redeem(code, groupContractId);

      if (!result) {
        return reply.status(404).send({ error: 'invite_not_found' });
      }

      return reply.status(200).send(result);
    }
  );
}
