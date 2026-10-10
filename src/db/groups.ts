import {
  db,
  getQueryResult,
} from "./client";
import { query } from "postgres";
import { GroupMemberData, RoundData } from "../types";

export async function getGroup(groupId: string) {
  const group = await db.query`
    SELECT * FROM groups WHERE id = ${groupId}
  `.then((rows) => rows[0]);

  if (!group) return null;

  const rounds = await db.query`
    WITH rounds AS (
      SELECT 
        r.id as round_id,
        r.number,
        r.start_date,
        r.end_date
      FROM rounds r
      WHERE r.group_id = ${groupId}
      ORDER BY r.number
    ),
    contributions AS (
      SELECT 
        c.round_id,
        c.member_id,
        c.amount,
        c.created_at
      FROM contributions c
      WHERE c.group_id = ${groupId}
    ),
    payouts_grouped AS (
      SELECT 
        p.round_id,
        p.member_id,
        SUM(p.amount) as total_payout
      FROM payouts p
      WHERE p.group_id = ${groupId}
      GROUP BY p.round_id, p.member_id
    ),
    fees_grouped AS (
      SELECT 
        f.round_id,
        SUM(f.amount) as total_fees
      FROM protocol_fees f
      WHERE f.group_id = ${groupId}
      GROUP BY f.round_id
    )
    SELECT 
      r.round_id,
      r.number,
      r.start_date,
      r.end_date,
      COALESCE(SUM(c.amount), 0) as total_contributions,
      COALESCE(fg.total_fees, 0) as total_fees,
      COALESCE((
        SELECT COUNT(*) 
        FROM contributions c2 
        WHERE c2.round_id = r.round_id
      ), 0) as contribution_count,
      COALESCE((
        SELECT SUM(pg.total_payout)
        FROM payouts_grouped pg
        WHERE pg.round_id = r.round_id
      ), 0) as total_payouts
    FROM rounds r
    LEFT JOIN contributions c ON c.round_id = r.round_id
    LEFT JOIN fees_grouped fg ON fg.round_id = r.round_id
    GROUP BY r.round_id, r.number, r.start_date, r.end_date, fg.total_fees
    ORDER BY r.number
  `;

  const members = await db.query`
    SELECT DISTINCT m.*
    FROM members m
    JOIN contributions c ON c.member_id = m.id
    WHERE c.group_id = ${groupId}
  `;

  const groupMemberData: GroupMemberData[] = members.map((member) => ({
    memberId: member.id,
    memberName: member.name,
    rounds: rounds.map((round) => {
      const roundContributions = rounds.flatMap((r) =>
        r.round_id === round.round_id ? [round] : []
      );

      return {
        roundId: round.round_id,
        roundNumber: round.number,
        startDate: round.start_date,
        endDate: round.end_date,
        totalContributions: round.total_contributions,
        totalFees: round.total_fees,
        contributionCount: round.contribution_count,
        totalPayouts: round.total_payouts,
      };
    }),
  }));

  return {
    ...group,
    rounds,
    members,
    groupMemberData,
  };
}
</parameter>
