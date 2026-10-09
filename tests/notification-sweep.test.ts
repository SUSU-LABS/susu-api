import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotificationSweeper } from '../src/db/notification-sweep';
import { createTestDb, type TestDb } from './support/pglite';

/**
 * The notification sweep, against a real Postgres.
 *
 * This is the one layer where a fake database is useless. The sweep is a single
 * `insert ... select` whose correctness lives entirely in its SQL — the joins
 * that decide who is addressed, the `on conflict` that makes it repeatable, the
 * `jsonb_build_object` that carries the amounts. A mock would assert that the
 * string was passed and nothing else, and every interesting mistake here (an
 * address joined to the wrong column, a payload key in the wrong case, a
 * conflict target that does not match the index) produces SQL that runs cleanly
 * and returns plausible wrong answers.
 */

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const USER_C = '33333333-3333-3333-3333-333333333333';

const ALICE = `G${'A'.repeat(55)}`;
const BOB = `G${'B'.repeat(55)}`;
const CAROL = `G${'C'.repeat(55)}`;
const STRANGER = `G${'D'.repeat(55)}`;

const GROUP_ONE = `C${'A'.repeat(55)}`;
const GROUP_TWO = `C${'B'.repeat(55)}`;

const FACTORY = `C${'F'.repeat(55)}`;
const CREATOR = `G${'E'.repeat(55)}`;
const TOKEN = `C${'T'.repeat(55)}`;

let test: TestDb;

beforeAll(async () => {
  test = await createTestDb();
  for (const id of [USER_A, USER_B, USER_C]) await test.createUser(id);
});

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  // Chain-derived and account tables both, because a case here can write to
  // either. `auth.users` is Supabase's and outlives the test. Deleting `groups`
  // cascades to `group_members`.
  await test.exec(`
    delete from public.notifications;
    delete from public.notification_examined;
    delete from public.decoded_events;
    delete from public.groups;
    delete from public.wallet_links;
  `);
  memberSequence.clear();
});

/** Links a wallet to an account, the way `/wallet/verify` does. */
async function link(userId: string, address: string): Promise<void> {
  await test.query('insert into public.wallet_links (user_id, address) values ($1, $2)', [
    userId,
    address,
  ]);
}

/**
 * The group a membership belongs to.
 *
 * Needed because `group_members.contract_id` references `groups` — the chain
 * cannot record a member of a group it has not recorded — so a fixture that
 * inserts a membership alone is rejected, exactly as the indexer would be.
 */
/**
 * Records a membership, creating the group row it belongs to.
 *
 * The group is needed because `group_members.contract_id` references `groups` —
 * the chain cannot record a member of a group it has not recorded — so a fixture
 * that inserts a membership alone is rejected, exactly as the indexer would be.
 * `on conflict do nothing` makes this safe to call for several members of one
 * group.
 */
async function memberOf(contractId: string, address: string): Promise<void> {
  groupSequence += 1;
  await test.query(
    `insert into public.groups
       (contract_id, factory_contract_id, group_id, creator, token,
        contribution_amount, member_capacity, created_ledger)
     values ($1, $2, $3, $4, $5, 10000000, 5, 90)
     on conflict (contract_id) do nothing`,
    [contractId, FACTORY, groupSequence, CREATOR, TOKEN],
  );

  // `group_members` has a unique `(contract_id, position)`, so the position has
  // to be distinct within a group rather than across calls.
  const position = (memberSequence.get(contractId) ?? 0) + 1;
  memberSequence.set(contractId, position);

  await test.query(
    `insert into public.group_members
       (contract_id, member, position, joined_ledger, event_identity)
     values ($1, $2, $3, 95, $4)`,
    [contractId, address, position, `join-${contractId.slice(0, 8)}-${position}`],
  );
}

/** Distinct `groups.group_id` per fixture; the real one is a factory sequence. */
let groupSequence = 0;

/** Distinct join position per group, as the contract assigns. */
const memberSequence = new Map<string, number>();

type ChainEvent = {
  identity: string;
  name: string;
  contractId?: string;
  ledger?: number;
  payload: Record<string, unknown>;
};

/** Records a decoded event exactly as the indexer's plan produces it. */
async function event(input: ChainEvent): Promise<void> {
  await test.query(
    `insert into public.decoded_events
       (event_identity, name, contract_id, ledger, tx_index, event_index, tx_hash, event_id, payload)
     values ($1, $2, $3, $4, 0, 0, $5, $6, $7)`,
    [
      input.identity,
      input.name,
      input.contractId ?? GROUP_ONE,
      input.ledger ?? 100,
      'a'.repeat(64),
      `paging-${input.identity}`,
      JSON.stringify(input.payload),
    ],
  );
}

async function notifications(): Promise<
  { user_id: string; kind: string; title: string; data: Record<string, unknown> }[]
> {
  const { rows } = await test.query(
    `select user_id, kind, title, data from public.notifications order by user_id, kind`,
  );
  return rows as never;
}

describe('the notification sweep', () => {
  it('writes nothing when no event has happened', async () => {
    const result = await createNotificationSweeper(test.db).sweep();

    expect(result).toEqual({ events: 0, written: 0, rounds: 0 });
    expect(await notifications()).toEqual([]);
  });

  it('tells the payer their contribution was confirmed', async () => {
    await link(USER_A, ALICE);
    await event({
      identity: 'evt-1',
      name: 'contribution',
      payload: { member: ALICE, round: 3, amount: '50000000' },
    });

    const result = await createNotificationSweeper(test.db).sweep();

    expect(result.written).toBe(1);
    const [row] = await notifications();
    expect(row).toMatchObject({ user_id: USER_A, kind: 'contribution_confirmed' });
    // The amount stays a base-unit string, as it is everywhere else. A number
    // here would be a JSON number, which cannot hold every i128.
    expect(row?.data).toEqual({
      contractId: GROUP_ONE,
      txHash: 'a'.repeat(64),
      round: 3,
      amount: '50000000',
    });
  });

  it('tells the recipient their payout arrived, with the net amount', async () => {
    await link(USER_B, BOB);
    await event({
      identity: 'evt-2',
      name: 'payout',
      payload: { recipient: BOB, round: 2, recipientAmount: '49750000' },
    });

    await createNotificationSweeper(test.db).sweep();

    const [row] = await notifications();
    expect(row).toMatchObject({ user_id: USER_B, kind: 'payout_confirmed' });
    expect(row?.data).toMatchObject({ amount: '49750000', round: 2 });
  });

  it('tells every linked member that the group finished', async () => {
    await link(USER_A, ALICE);
    await link(USER_B, BOB);
    await memberOf(GROUP_ONE, ALICE);
    await memberOf(GROUP_ONE, BOB);
    await memberOf(GROUP_ONE, STRANGER);
    await event({ identity: 'evt-3', name: 'completed', payload: { rounds: 5 } });

    const result = await createNotificationSweeper(test.db).sweep();

    // Three members, two of whom have a linked wallet.
    expect(result.written).toBe(2);
    expect((await notifications()).map((row) => row.user_id).sort()).toEqual([USER_A, USER_B]);
  });

  it('does not address an event to a wallet with no account', async () => {
    await event({
      identity: 'evt-4',
      name: 'contribution',
      payload: { member: STRANGER, round: 1, amount: '10000000' },
    });

    const result = await createNotificationSweeper(test.db).sweep();

    // Looked at, and correctly produced nothing. It is counted as seen so the
    // loop advances rather than re-reading it forever.
    expect(result.events).toBe(1);
    expect(result.written).toBe(0);
    expect(await notifications()).toEqual([]);
  });

  it('does not address one group’s completion to another group’s members', async () => {
    await link(USER_A, ALICE);
    await memberOf(GROUP_TWO, ALICE);
    await event({
      identity: 'evt-5',
      name: 'completed',
      contractId: GROUP_ONE,
      payload: { rounds: 3 },
    });

    await createNotificationSweeper(test.db).sweep();

    expect(await notifications()).toEqual([]);
  });

  it('is idempotent, so it may be re-run as often as anyone likes', async () => {
    await link(USER_A, ALICE);
    await link(USER_B, BOB);
    await memberOf(GROUP_ONE, BOB);
    await event({
      identity: 'evt-6',
      name: 'contribution',
      payload: { member: ALICE, round: 1, amount: '50000000' },
    });
    await event({ identity: 'evt-7', name: 'completed', payload: { rounds: 3 } });

    const sweeper = createNotificationSweeper(test.db);
    const first = await sweeper.sweep();
    const second = await sweeper.sweep();
    const third = await sweeper.sweep();

    expect(first.written).toBe(2);
    // Already derived, so the second run finds no candidates at all — and the
    // count is the same either way, which is the property that matters.
    expect(second.written).toBe(0);
    expect(third.written).toBe(0);
    expect((await notifications()).length).toBe(2);
  });

  it('refuses a duplicate even when two sweeps race on the same event', async () => {
    await link(USER_A, ALICE);
    await event({
      identity: 'evt-8',
      name: 'contribution',
      payload: { member: ALICE, round: 1, amount: '10000000' },
    });

    // Both see the same candidate, because neither has written yet. The unique
    // index is what makes the second a no-op rather than a duplicate — this is
    // the reason the conflict target exists rather than a read-then-write check.
    const [a, b] = await Promise.all([
      createNotificationSweeper(test.db).sweep(),
      createNotificationSweeper(test.db).sweep(),
    ]);

    expect(a.written + b.written).toBe(1);
    expect((await notifications()).length).toBe(1);
  });

  it('ignores events that are not addressed to a person', async () => {
    await link(USER_A, ALICE);
    await memberOf(GROUP_ONE, ALICE);

    for (const [index, name] of ['join', 'start', 'fee', 'group_created'].entries()) {
      await event({ identity: `evt-ignored-${index}`, name, payload: { member: ALICE } });
    }

    const result = await createNotificationSweeper(test.db).sweep();

    expect(result).toEqual({ events: 0, written: 0, rounds: 0 });
  });

  it('converges on a backlog without repeating itself', async () => {
    await link(USER_A, ALICE);

    for (let index = 0; index < 7; index += 1) {
      await event({
        identity: `evt-backlog-${index}`,
        name: 'contribution',
        payload: { member: ALICE, round: index + 1, amount: '50000000' },
      });
    }

    // A batch of two means four rounds to cover seven events.
    const result = await createNotificationSweeper(test.db).sweep({
      batchSize: 2,
      maxRounds: 10,
    });

    expect(result.events).toBe(7);
    expect(result.written).toBe(7);
    expect(result.rounds).toBe(4);
    expect((await notifications()).length).toBe(7);
  });

  it('stops at its round ceiling and leaves the rest for the next call', async () => {
    await link(USER_A, ALICE);

    for (let index = 0; index < 6; index += 1) {
      await event({
        identity: `evt-capped-${index}`,
        name: 'contribution',
        payload: { member: ALICE, round: index + 1, amount: '50000000' },
      });
    }

    const capped = await createNotificationSweeper(test.db).sweep({ batchSize: 2, maxRounds: 2 });
    expect(capped.written).toBe(4);

    // The next invocation picks up where it stopped, because a notification that
    // was not written is indistinguishable from one that was never derived.
    const rest = await createNotificationSweeper(test.db).sweep({ batchSize: 2, maxRounds: 10 });
    expect(rest.written).toBe(2);
    expect((await notifications()).length).toBe(6);
  });

  it('works oldest-first, so a long backlog arrives in the order it happened', async () => {
    await link(USER_A, ALICE);
    await event({
      identity: 'evt-later',
      name: 'contribution',
      ledger: 200,
      payload: { member: ALICE, round: 2, amount: '50000000' },
    });
    await event({
      identity: 'evt-earlier',
      name: 'contribution',
      ledger: 100,
      payload: { member: ALICE, round: 1, amount: '50000000' },
    });

    await createNotificationSweeper(test.db).sweep({ batchSize: 1, maxRounds: 10 });

    const { rows } = await test.query(
      `select data -> 'round' as round from public.notifications order by created_at, id`,
    );
    expect(rows.map((row) => row['round'])).toEqual([1, 2]);
  });

  it('gives each row in a sweep a distinct timestamp, so order never falls to chance', async () => {
    await link(USER_A, ALICE);
    for (let index = 0; index < 5; index += 1) {
      await event({
        identity: `evt-tie-${index}`,
        name: 'contribution',
        ledger: 100 + index,
        payload: { member: ALICE, round: index + 1, amount: '50000000' },
      });
    }

    await createNotificationSweeper(test.db).sweep({ batchSize: 5, maxRounds: 1 });

    // This is the bug that made the ordering test fail about half the time. One
    // sweep is one statement, so `now()` — which is transaction-start time — gave
    // every row the same `created_at`. The list query then broke the tie on `id`,
    // and `id` is a random UUID: a coin flip, not an order. The timestamps must
    // therefore be distinct, which is the property the fix is actually about,
    // asserted directly rather than through its symptom.
    //
    // Counted in SQL rather than in JavaScript: the fix separates rows by a
    // microsecond and `Date#getTime()` is milliseconds, so a comparison on this
    // side of the wire would report five identical values whether or not the fix
    // worked — a test that cannot fail.
    const { rows } = await test.query(
      `select count(*) as total, count(distinct created_at) as distinct_total
       from public.notifications`,
    );
    // Coerced rather than compared as a string: PGlite hands `count(*)` back as a
    // number, and Postgres over the wire as a string. The property under test is
    // that the two counts are equal, not which driver said so.
    expect(Number(rows[0]?.['total'])).toBe(5);
    expect(Number(rows[0]?.['distinct_total'])).toBe(5);

    // And ordered from the database's point of view, which is the only ordering
    // the API's `limit`/`offset` paging can rely on.
    const { rows: ordered } = await test.query(
      `select data -> 'round' as round from public.notifications order by created_at`,
    );
    expect(ordered.map((row) => row['round'])).toEqual([1, 2, 3, 4, 5]);
  });

  it('carries the group and transaction, so a message can be checked', async () => {
    await link(USER_A, ALICE);
    await link(USER_C, CAROL);
    await memberOf(GROUP_TWO, CAROL);
    await event({
      identity: 'evt-group-two',
      name: 'payout',
      contractId: GROUP_TWO,
      payload: { recipient: CAROL, round: 1, recipientAmount: '49750000' },
    });

    await createNotificationSweeper(test.db).sweep();

    const [row] = await notifications();
    // The event is a summary of an artifact. Anything shown from it must say
    // which artifact, or it cannot be checked against the chain.
    expect(row?.data).toMatchObject({ contractId: GROUP_TWO });
    expect(row?.data['txHash']).toBe('a'.repeat(64));
  });

  it('writes a title for every kind it produces', async () => {
    await link(USER_A, ALICE);
    await memberOf(GROUP_ONE, ALICE);
    await event({
      identity: 'evt-t1',
      name: 'contribution',
      payload: { member: ALICE, round: 1, amount: '1' },
    });
    await event({
      identity: 'evt-t2',
      name: 'payout',
      payload: { recipient: ALICE, round: 1, recipientAmount: '1' },
    });
    await event({ identity: 'evt-t3', name: 'completed', ledger: 300, payload: { rounds: 1 } });

    await createNotificationSweeper(test.db).sweep();

    const rows = await notifications();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.kind).toMatch(/^[a-z_]+$/);
    }
  });

  it('survives a payload whose address is missing or the wrong shape', async () => {
    await link(USER_A, ALICE);

    // These are decoder disagreements rather than user input, but they must not
    // take down the sweep: one unreadable event cannot stop the rest.
    await event({ identity: 'evt-bad-1', name: 'contribution', payload: {} });
    await event({ identity: 'evt-bad-2', name: 'contribution', payload: { member: 42 } });
    await event({
      identity: 'evt-bad-3',
      name: 'payout',
      payload: { recipient: null, round: 1 },
    });
    await event({
      identity: 'evt-good',
      name: 'contribution',
      payload: { member: ALICE, round: 1, amount: '50000000' },
    });

    const result = await createNotificationSweeper(test.db).sweep();

    expect(result.written).toBe(1);
  });

  it('does not starve behind events with no linked wallet', async () => {
    // Three events whose subject wallet is not linked: they can never produce
    // a notification, so without tombstoning they are reselected every round
    // and the sweep never reaches the addressable event behind them.
    await event({
      identity: 'evt-unaddr-1',
      name: 'contribution',
      ledger: 100,
      payload: { member: STRANGER, round: 1, amount: '1' },
    });
    await event({
      identity: 'evt-unaddr-2',
      name: 'contribution',
      ledger: 101,
      payload: { member: STRANGER, round: 1, amount: '1' },
    });
    await event({
      identity: 'evt-unaddr-3',
      name: 'contribution',
      ledger: 102,
      payload: { member: STRANGER, round: 1, amount: '1' },
    });

    await link(USER_A, ALICE);
    await event({
      identity: 'evt-addr',
      name: 'contribution',
      ledger: 103,
      payload: { member: ALICE, round: 1, amount: '50000000' },
    });

    // batchSize 3: the first round sees only the three unaddressable events.
    // Without the fix, every round reselects the same three and the
    // addressable event is never reached.
    const first = await createNotificationSweeper(test.db).sweep({ batchSize: 3 });

    expect(first.written).toBe(1);
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER_A, kind: 'contribution_confirmed' });

    // The unaddressable events were examined once and tombstoned.
    const { rows: tombstoned } = await test.query(
      'select event_identity from public.notification_examined order by event_identity',
    );
    expect(tombstoned.map((r) => r.event_identity)).toEqual([
      'evt-unaddr-1',
      'evt-unaddr-2',
      'evt-unaddr-3',
    ]);

    // A second sweep finds nothing left to do.
    const second = await createNotificationSweeper(test.db).sweep({ batchSize: 3 });
    expect(second).toEqual({ events: 0, written: 0, rounds: 0 });
  });
});
