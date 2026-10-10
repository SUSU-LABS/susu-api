import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import type { PgTransaction } from "drizzle-orm/pg-core";

export const groupTable = pgTable("groups", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull(),
  creatorId: text("creator_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export async function getGroup(
  db: typeof import("./index").db,
  contractId: string,
): Promise<Record<string, unknown> | null> {
  const [group] = await db
    .select()
    .from(groupTable)
    .where(sql`groups.contract_id = ${contractId}`)
    .limit(1);

  if (!group) {
    return null;
  }

  // Fetch latest round data with robust aggregation for duplicate rows
  const roundData = await db
    .select({
      round: sql<number>`MAX(r.round)`,
      totalPayout: sql<number>`MAX(r.total_payout)`,
      fee: sql<number>`COALESCE((SELECT MAX(f.amount) FROM fees f WHERE f.contract_id = ${contractId} AND f.round = MAX(r.round)), 0)`,
      recipient: sql<string>`COALESCE((SELECT f.recipient FROM fees f WHERE f.contract_id = ${contractId} AND f.round = MAX(r.round) LIMIT 1), '')`,
      payout: sql<number>`COALESCE((SELECT MAX(p.amount) FROM payouts p WHERE p.contract_id = ${contractId} AND p.round = MAX(r.round)), 0)`,
    })
    .from(sql`rounds r`)
    .where(sql`r.contract_id = ${contractId}`)
    .groupBy(sql`r.contract_id`)
    .limit(1);

  if (roundData.length === 0) {
    return { ...group };
  }

  return {
    ...group,
    round: Number(roundData[0].round),
    totalPayout: Number(roundData[0].totalPayout),
    payout: Number(roundData[0].payout),
    recipient: roundData[0].recipient,
    fee: Number(roundData[0].fee),
  };
}
