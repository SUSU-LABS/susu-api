Repositório: SUSU-LABS/susu-api
Issue: #58 - Uso de dois relógios para group-registration expiry

Problema identificado:
- `src/db/registrations.ts:126` usa `Date.now() + TTL` (relógio da aplicação)
- `isRegistered` e deleted-row compar contra o relógio do banco (`sql\`now()\``)
- `created_at` usa banco `now()`
- Isso causa inconsistência quando há skew entre os relógios

Solução proposta:
- Computar expiry em SQL consistentemente
- OU comparar consistentemente no relógio da aplicação
