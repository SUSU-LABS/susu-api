import {
  type Client,
  type DBTx,
} from './client'
import { type Invite } from './types'

export async function getInvite(tx: Client, code: string): Promise<Invite | null> {
  const result = await tx.query(
    'SELECT * FROM invites WHERE code = $1 LIMIT 1',
    [code],
  )
  return result.rows[0] ?? null
}

export async function getInviteForUpdate(tx: Client, code: string): Promise<Invite | null> {
  const result = await tx.query(
    'SELECT * FROM invites WHERE code = $1 FOR UPDATE LIMIT 1',
    [code],
  )
  return result.rows[0] ?? null
}

export async function claimInvite(tx: DBTx, invite: Invite, groupContractId: string): Promise<void> {
  await tx.query(
    'UPDATE invites SET redeemed_at = NOW(), group_contract_id = $1 WHERE id = $2',
    [groupContractId, invite.id],
  )
}

export async function createInvite(tx: DBTx, groupId: string): Promise<Invite> {
  const result = await tx.query(
    'INSERT INTO invites (group_id) VALUES ($1) RETURNING *',
    [groupId],
  )
  return result.rows[0]
}
