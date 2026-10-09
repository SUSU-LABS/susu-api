-- Susu Protocol — the notification sweep's memory of what it examined.
--
-- THE BUG THIS FIXES
-- `derive_notifications` picks its batch as "events with no notification row",
-- ordered by chain position, limited to batch_size. An event whose subject has
-- no linked wallet produces no notification — and therefore stays a candidate
-- forever. Once batch_size such unaddressable events are older than any
-- addressable one, every sweep reselects the same rows and newer events are
-- never reached. The sweep starves: it does work every round and makes no
-- progress.
--
-- THE FIX
-- Remember "examined, produced nothing". After each round's write step, the
-- batch identities that produced no notification row are recorded in
-- `notification_examined`, and the candidate step excludes them. An event is
-- examined at most once, so the sweep always advances past unaddressable
-- history toward events it can deliver.
--
-- WHAT THIS IS NOT
-- A tombstone is permanent: if a wallet is linked after its events were
-- examined and tombstoned, those events will not produce notifications. That is
-- the price of the sweep advancing. The alternative — re-examining the same
-- unaddressable events forever — is the starvation this fixes. An event that
-- produced even one notification is *not* tombstoned; it is excluded by the
-- notifications table itself, so partial addressability keeps working.
--
-- WHY NOT A WATERMARK
-- A watermark ("derived up to ledger N") goes stale the moment a pass is
-- partial or a run is interrupted, and then notifications are silently skipped
-- rather than safely repeated. Tombstones are per-identity, so a sweep may be
-- re-run as often as anything likes without losing or duplicating anything.
--> statement-breakpoint

create table public.notification_examined (
  event_identity text primary key,
  examined_at timestamptz not null default now()
);
--> statement-breakpoint

comment on table public.notification_examined is
  'Event identities the notification sweep examined without producing a notification (no linked wallet). Excluded from future candidate batches so unaddressable history cannot starve the sweep.';
--> statement-breakpoint

-- Internal to the sweep: no user-facing policy, so RLS denies everyone but the
-- owner and bypassrls roles (service_role, which the sweep runs as).
alter table public.notification_examined enable row level security;
--> statement-breakpoint

grant select, insert, delete on public.notification_examined to service_role;
--> statement-breakpoint

create or replace function public.derive_notifications(
  batch_size integer default 500,
  max_rounds integer default 20
)
returns table (events integer, written integer, rounds integer)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  batch text[];
  inserted integer;
  consumed integer := 0;
  produced integer := 0;
  passes integer := 0;
  offset_base integer;
begin
  if batch_size is null or batch_size < 1 then
    raise exception 'batch_size must be at least 1';
  end if;
  if max_rounds is null or max_rounds < 1 then
    raise exception 'max_rounds must be at least 1';
  end if;

  loop
    exit when passes >= max_rounds;

    -- The candidate step and the write step are separate statements on purpose;
    -- see the note in 0006 about advancing on what was examined.
    --
    -- Tombstoned events are excluded: without this, a batch of unaddressable
    -- events (no linked wallet) is reselected every round and the sweep never
    -- reaches newer events.
    select array_agg(e.event_identity) into batch
    from (
      select event_identity
      from public.decoded_events e
      where e.name in ('contribution', 'payout', 'completed')
        and not exists (
          select 1 from public.notifications n
          where n.source_event_identity = e.event_identity
        )
        and not exists (
          select 1 from public.notification_examined x
          where x.event_identity = e.event_identity
        )
      order by e.ledger, e.tx_index, e.event_index
      limit batch_size
    ) e;

    exit when batch is null or array_length(batch, 1) is null;

    offset_base := consumed;
    consumed := consumed + array_length(batch, 1);
    passes := passes + 1;

    with candidates as (
      -- The chain position travels with the event. It is the only total order the
      -- decoded events have, and the reason the resulting notifications can be
      -- ordered at all.
      select
        e.event_identity, e.name, e.contract_id, e.tx_hash, e.payload,
        e.ledger, e.tx_index, e.event_index
      from public.decoded_events e
      where e.event_identity = any(batch)
    ),
    derived as (
      -- The payer. Addressed to them because they are the one waiting to know
      -- the round counted them in.
      select
        w.user_id,
        'contribution_confirmed'::text as kind,
        'Contribution confirmed'::text as title,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'round', c.payload -> 'round',
          'amount', c.payload -> 'amount'
        ) as data,
        c.event_identity as source_event_identity,
        c.ledger as ledger,
        c.tx_index as tx_index,
        c.event_index as event_index
      from candidates c
      join public.wallet_links w on w.address = c.payload ->> 'member'
      where c.name = 'contribution'

      union all

      -- The round's recipient. The payload's `recipient_amount` is already net of
      -- the protocol fee, which is the number they care about.
      select
        w.user_id,
        'payout_confirmed'::text,
        'Payout confirmed'::text,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'round', c.payload -> 'round',
          'amount', c.payload -> 'recipientAmount'
        ),
        c.event_identity,
        c.ledger,
        c.tx_index,
        c.event_index
      from candidates c
      join public.wallet_links w on w.address = c.payload ->> 'recipient'
      where c.name = 'payout'

      union all

      -- The group finished. The event names nobody, so it goes to every member
      -- whose wallet is linked.
      select
        w.user_id,
        'group_completed'::text,
        'Group completed'::text,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'rounds', c.payload -> 'rounds'
        ),
        c.event_identity,
        c.ledger,
        c.tx_index,
        c.event_index
      from candidates c
      join public.group_members m on m.contract_id = c.contract_id
      join public.wallet_links w on w.address = m.member
      where c.name = 'completed'
    )
    insert into public.notifications (
      user_id, kind, title, data, source_event_identity, created_at
    )
    select
      user_id,
      kind,
      title,
      data,
      source_event_identity,
      -- One microsecond per step through the batch, offset by everything already
      -- written in this call, so the sequence is strictly increasing across rounds
      -- as well as within one. Distinct timestamps also mean the `id` tiebreak in
      -- the list query is never reached, which is what removes the coin flip.
      now() + (
        (offset_base + row_number() over (order by ledger, tx_index, event_index))
        * interval '1 microsecond'
      )
    from derived
    on conflict (user_id, kind, source_event_identity) do nothing;

    get diagnostics inserted = row_count;
    produced := produced + inserted;

    -- Remember what was examined but produced nothing, so the next round does
    -- not reselect the same unaddressable events. Events that produced a
    -- notification need no tombstone: the notifications table excludes them,
    -- and `on conflict do nothing` keeps the re-derivation safe.
    insert into public.notification_examined (event_identity)
    select examined.identity
    from unnest(batch) as examined(identity)
    where not exists (
      select 1 from public.notifications n
      where n.source_event_identity = examined.identity
    )
    on conflict do nothing;

    exit when array_length(batch, 1) < batch_size;
  end loop;

  return query select consumed, produced, passes;
end;
$function$;
--> statement-breakpoint

comment on function public.derive_notifications(integer, integer) is
  'Turns decoded chain events into user-addressed notifications, in chain order. Idempotent by event identity, so it may be run as often as anything likes. Events examined without producing a notification are tombstoned in notification_examined so unaddressable history cannot starve the sweep.';
--> statement-breakpoint

-- `create or replace` keeps the existing grants and owner, but they are restated
-- so this migration describes the function's access posture on its own rather
-- than relying on the reader having 0007 to hand.
revoke all on function public.derive_notifications(integer, integer) from public;
--> statement-breakpoint

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.derive_notifications(integer, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.derive_notifications(integer, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.derive_notifications(integer, integer) to service_role';
  end if;
end
$$;
--> statement-breakpoint
