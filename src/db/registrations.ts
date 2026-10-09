import { db } from '../db/index.js';
import { groupRegistrations, groups } from '../db/schema.js';
import { eq, and, gt, sql } from 'drizzle-orm';

// Compute expiry consistently in SQL to avoid clock skew issues
const TTL_MS = 30 * 60 * 1000; // 30 minutes in milliseconds

export async function registerGroup(groupId: string, member: string) {
  const now = await getDbNow();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  
  const [existing] = await db
    .select()
    .from(groupRegistrations)
    .where(
      and(
        eq(groupRegistrations.groupId, groupId),
        eq(groupRegistrations.member, member),
        gt(groupRegistrations.expiresAt, expiresAt)
      )
    );
  
  if (existing) {
    throw new Error('Already registered');
  }
  
  const [registration] = await db
    .insert(groupRegistrations)
    .values({
      groupId,
      member,
      createdAt: now,
      expiresAt,
    })
    .returning();
  
  return registration;
}

export async function isRegistered(groupId: string, member: string): Promise<boolean> {
  const now = await getDbNow();
  
  const [existing] = await db
    .select()
    .from(groupRegistrations)
    .where(
      and(
        eq(groupRegistrations.groupId, groupId),
        eq(groupRegistrations.member, member),
        gt(groupRegistrations.expiresAt, now)
      )
    );
  
  return !!existing;
}

export async function deleteExpiredRows() {
  const now = await getDbNow();
  
  await db
    .delete(groupRegistrations)
    .where(sql`${groupRegistrations.expiresAt} < ${now}`);
}

async function getDbNow(): Promise<Date> {
  const [{ now }] = await db
    .select({ now: sql`now()` })
    .from(groups);
  return new Date(now);
}
