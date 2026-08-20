-- Susu Protocol — RLS policy guard
--
-- Run with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/rls_policy_guard.sql
--
-- Requires the migrations to have been applied, and the Supabase shims
-- (`bootstrap_supabase_shims.sql`) to exist so `auth.uid()` resolves.
--
-- WHY THIS IS SEPARATE FROM `rls_enabled_guard.sql`
-- That guard answers "is RLS switched on?". This one answers "does it actually
-- keep anyone out?". The two are not the same question, and only the first can
-- be answered by reading catalog flags. A table can have RLS enabled and a
-- policy that is subtly too broad — `using (true)`, a missing `with check`, a
-- comparison against the wrong column — and every structural check still passes.
--
-- So these tests act as the roles themselves and assert on outcomes: what a user
-- can see, what they can change, and what they are refused. Where an operation
-- must be refused, the test fails if it *succeeds*.
--
-- WHY ROLE AND CLAIMS ARE SET AT SESSION LEVEL
-- An earlier draft used `set local role` / `set local "request.jwt.claim.sub"`
-- inside `begin ... rollback`. That works in psql, but it makes every assertion
-- depend on transaction-scoped settings surviving correctly across a caught
-- exception, and it cannot be exercised by a driver that manages transactions
-- differently. Setting the role and the claim for the session, and resetting
-- them explicitly, keeps each assertion self-contained: it does not matter what
-- the previous test did, or how the statements were batched.
--
-- Data-mutating assertions are still wrapped in a transaction that is rolled
-- back, so the guard leaves no rows behind and can be run repeatedly.

\set ON_ERROR_STOP on

-- Fixed identifiers so failures name a specific user rather than a value that
-- changes each run.
\set user_one '''11111111-1111-1111-1111-111111111111'''
\set user_two '''22222222-2222-2222-2222-222222222222'''

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Seeded as the connecting (super)user, which owns the table and so is not
-- subject to its policies. `on conflict` keeps re-runs safe.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values (:user_one), (:user_two)
on conflict (id) do nothing;

insert into public.profiles (user_id, display_name) values
  (:user_one, 'User One'),
  (:user_two, 'User Two')
on conflict (user_id) do nothing;

-- Fail before the assertions if referential behaviour is wrong, so the cause is
-- named rather than showing up as a confusing count mismatch later.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'f'
      and confdeltype = 'c'
  ) then
    raise exception
      'profiles has no ON DELETE CASCADE foreign key. Deleting a user would leave their profile behind.';
  end if;
  raise notice 'ok: profiles cascades from auth.users';
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Anonymous users are refused, by privilege rather than by policy.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.profiles;
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'anon was able to read public.profiles';
  end if;
  raise notice 'ok: anon cannot read profiles';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.profiles (user_id, display_name)
    values ('33333333-3333-3333-3333-333333333333', 'anon');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'anon was able to write to public.profiles';
  end if;
  raise notice 'ok: anon cannot write profiles';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. A signed-in user sees their own profile and no one else's.
--    The second assertion is the ownership boundary: two rows exist, and one
--    must be invisible.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :user_one, false);
set role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.profiles
  where user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then
    raise exception 'user one could not read their own profile (saw % row(s))', n;
  end if;
  raise notice 'ok: user reads their own profile';
end
$$;

do $$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n <> 1 then
    raise exception 'user one saw % profile(s); the policy is not restricting rows to the owner', n;
  end if;
  raise notice 'ok: user cannot see other profiles';
end
$$;

-- ---------------------------------------------------------------------------
-- 3. A user may edit their own fields, and may not reach another user's row.
--    The successful update is transactional so it leaves no trace.
-- ---------------------------------------------------------------------------
begin;
do $$
declare n int;
begin
  update public.profiles set display_name = 'Renamed'
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'user one could not update their own profile (% row(s))', n;
  end if;
  raise notice 'ok: user updates their own profile';
end
$$;
rollback;

do $$
declare n int;
begin
  update public.profiles set display_name = 'Taken over'
  where user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'user one updated % row(s) belonging to another user', n;
  end if;
  raise notice 'ok: cannot update another user''s profile';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. A user cannot create a profile under another identity.
--    This is what `with check` exists for: without it the policy would decide
--    only whether the statement runs, not what it may write.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    insert into public.profiles (user_id, display_name)
    values ('22222222-2222-2222-2222-222222222222', 'forged');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to create a profile for another user';
  end if;
  raise notice 'ok: cannot insert a profile for another user';
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Column-level grants hold the line that RLS cannot.
--
--    RLS filters rows, not columns. Were `update` granted on the table rather
--    than on specific columns, a user could reassign their own `user_id` — which
--    from their point of view means handing the profile to someone else and
--    losing access to it — and could rewrite `created_at`, a historical fact.
--    These assertions are what justify the narrower grant.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    update public.profiles set user_id = '22222222-2222-2222-2222-222222222222'
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to reassign their profile to another user';
  end if;
  raise notice 'ok: user_id is not updatable by the client';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    update public.profiles set created_at = now()
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to rewrite created_at';
  end if;
  raise notice 'ok: created_at is not updatable by the client';
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Deletion is not reachable from the browser.
--
--    Account deletion is a server-side operation with consequences for
--    application data. A user cannot trigger it with one call against the row
--    that holds their identity.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    delete from public.profiles where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to delete their own profile row';
  end if;
  raise notice 'ok: clients cannot delete profiles';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. The server path still sees everything.
--
--    A guard that only proves denial can pass while access that is required is
--    also broken. `service_role` bypasses RLS, and this asserts it, so a future
--    policy change that inadvertently locked out the server would be caught
--    here rather than in production.
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n < 2 then
    raise exception 'service_role saw % row(s); the server path cannot read profiles', n;
  end if;
  raise notice 'ok: service_role reads across owners';
end
$$;

reset role;

-- ===========================================================================
-- 8. Phase 5 tables: wallet links, invites, notifications.
--
--    These are asserted here rather than in a separate file because the
--    reasoning that makes them safe is the same reasoning as above: RLS plus
--    grants plus column-level grants, and only the last of those can express
--    "this column but not that one".
--
--    Two of the three tables are deliberately *less* reachable than a client
--    would like, so the assertions below prove denial rather than access:
--
--      * wallet_links  — a binding is only meaningful if the server established
--                        it, so the browser may read and nothing else.
--      * invite_links  — a code is only meaningful if it cannot be listed, so
--                        the browser is granted nothing at all.
-- ===========================================================================

\set wallet_one '''GBPJ3JJLZ7XPV6CGF3ABPSTXAATKRBCU2L6P66LHCGLYPBVMJX5BEFH6'''
\set wallet_two '''GBG4MSIEUTONQSE7SSUQ6QZTQPNMKCSESZ6TZKZCMZRMAKZSDO6QPCYK'''
\set group_id '''CCC7KAX4V4GJD6FVG6GSYQ4I2D2B3CWEOQMIX6YM4QBGXTA6INCGRUYC'''
\set invite_code '''abcdefghijklmnopqrstuvwxyz0123456789ABCD'''

-- psql substitutes :variables before the server ever parses the statement, but it
-- does not substitute inside a dollar-quoted body — the server receives a literal
-- ':' and rejects the statement. The refusal checks below need those values inside
-- a `do $$ ... $$` block to trap a constraint violation, so the values are
-- republished as session settings, which the blocks can read across that boundary.
--
-- Republished rather than re-typed: a hand-copied literal inside a block would
-- keep passing after the value above changed, turning a real assertion into a
-- vacuous one, which is the exact failure this guard exists to prevent.
select set_config('guard.group_id', :group_id, false),
       set_config('guard.user_id', :user_one, false);

insert into public.wallet_links (user_id, address) values
  (:user_one, :wallet_one),
  (:user_two, :wallet_two)
on conflict (user_id) do nothing;

insert into public.notifications (user_id, kind, title) values
  (:user_one, 'payout_confirmed', 'Your payout was confirmed'),
  (:user_two, 'payout_confirmed', 'Your payout was confirmed')
on conflict do nothing;

insert into public.invite_links (code, group_contract_id, created_by, max_uses) values
  (:invite_code, :group_id, :user_one, 5)
on conflict (code) do nothing;

-- Referential behaviour, named before the assertions so a breakage reports its
-- cause rather than surfacing later as a confusing count.
--
-- Counted rather than compared as a concatenated list: `string_agg` without an
-- ORDER BY returns rows in whatever order the planner chose, so comparing the
-- string would make this guard fail depending on the plan it happened to take.
do $$
declare cascading int;
begin
  select count(distinct t.relname)
  into cascading
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname in ('wallet_links', 'notifications', 'invite_links')
    and c.contype = 'f'
    and c.confdeltype = 'c';

  if cascading <> 3 then
    raise exception
      'expected all three Phase 5 tables to cascade from auth.users; found %',
      cascading;
  end if;
  raise notice 'ok: wallet_links, notifications and invite_links cascade from auth.users';
end
$$;

-- The invite code shape is a security control, not a formatting preference: it
-- is what stops this project repeating its own first mistake, where the group's
-- contract address was used as the invite code. That value is long and
-- high-entropy — so a length check passes it — but it is published on chain and
-- therefore enumerable. Asserted as a refusal, because a constraint that is
-- never exercised is a constraint that may not work.
do $$
declare
  refused boolean := false;
  v_group text := current_setting('guard.group_id');
  v_user  uuid := current_setting('guard.user_id');
begin
  begin
    insert into public.invite_links (code, group_contract_id, created_by)
    values (v_group, v_group, v_user);
  exception when check_violation then
    refused := true;
  end;

  if not refused then
    raise exception
      'a Stellar contract address was accepted as an invite code; it is publicly enumerable';
  end if;
  raise notice 'ok: an address-shaped invite code is refused';
end
$$;

do $$
declare
  refused boolean := false;
  v_group text := current_setting('guard.group_id');
  v_user  uuid := current_setting('guard.user_id');
begin
  begin
    insert into public.invite_links (code, group_contract_id, created_by)
    values ('tooshort', v_group, v_user);
  exception when check_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'an invite code below the entropy floor was accepted';
  end if;
  raise notice 'ok: a short invite code is refused';
end
$$;

-- ---------------------------------------------------------------------------
-- 8a. Anonymous users reach none of the three.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.wallet_links;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'anon was able to read public.wallet_links';
  end if;
  raise notice 'ok: anon cannot read wallet_links';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.invite_links;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'anon was able to read public.invite_links';
  end if;
  raise notice 'ok: anon cannot read invite_links';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.notifications;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'anon was able to read public.notifications';
  end if;
  raise notice 'ok: anon cannot read notifications';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8b. A signed-in user reads only their own wallet binding, and cannot set it.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :user_one, false);
set role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.wallet_links;
  if n <> 1 then
    raise exception 'user one saw % wallet link(s); expected only their own', n;
  end if;
  raise notice 'ok: user sees only their own wallet link';
end
$$;

-- The heart of the design: binding requires proof of key control, so a client
-- that could insert here would bypass the nonce-and-signature handshake entirely.
do $$
declare denied boolean := false;
begin
  begin
    insert into public.wallet_links (user_id, address)
    values ('11111111-1111-1111-1111-111111111111', 'GBG4MSIEUTONQSE7SSUQ6QZTQPNMKCSESZ6TZKZCMZRMAKZSDO6QPCYK');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to bind a wallet without proving control of it';
  end if;
  raise notice 'ok: clients cannot bind a wallet directly';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    update public.wallet_links set address = 'GBG4MSIEUTONQSE7SSUQ6QZTQPNMKCSESZ6TZKZCMZRMAKZSDO6QPCYK'
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to rewrite their wallet binding';
  end if;
  raise notice 'ok: clients cannot rewrite a wallet binding';
end
$$;

-- ---------------------------------------------------------------------------
-- 8c. Invite codes are not readable by any browser role.
--
--    This is the assertion that makes the opaque code worth generating. If a
--    client could list invite rows, it would not need to guess a code.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.invite_links;
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'an authenticated user was able to read invite_links';
  end if;
  raise notice 'ok: authenticated users cannot read invite_links';
end
$$;

do $$
declare
  denied boolean := false;
  v_group text := current_setting('guard.group_id');
  v_user  uuid := current_setting('guard.user_id');
begin
  begin
    insert into public.invite_links (code, group_contract_id, created_by)
    values ('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', v_group, v_user);
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'an authenticated user was able to create an invite directly';
  end if;
  raise notice 'ok: authenticated users cannot create invites directly';
end
$$;

-- ---------------------------------------------------------------------------
-- 8d. Notifications are user-owned: read, mark read, and nothing else.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.notifications;
  if n <> 1 then
    raise exception 'user one saw % notification(s); expected only their own', n;
  end if;
  raise notice 'ok: user sees only their own notifications';
end
$$;

begin;
do $$
declare n int;
begin
  update public.notifications set read_at = now()
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'user one could not mark their own notification read (% row(s))', n;
  end if;
  raise notice 'ok: user marks their own notification read';
end
$$;
rollback;

-- Column grants are what stop a notification being rewritten into a different
-- message. Without them, "payout confirmed" is a string the recipient's own
-- client can author.
do $$
declare denied boolean := false;
begin
  begin
    update public.notifications set title = 'Fake payout'
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to rewrite a notification title';
  end if;
  raise notice 'ok: notification content is not client-writable';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.notifications (user_id, kind, title)
    values ('11111111-1111-1111-1111-111111111111', 'payout_confirmed', 'Fake');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to fabricate a notification';
  end if;
  raise notice 'ok: clients cannot fabricate notifications';
end
$$;

do $$
declare n int;
begin
  update public.notifications set read_at = now()
  where user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'user one marked % of another user''s notifications read', n;
  end if;
  raise notice 'ok: cannot reach another user''s notifications';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    delete from public.notifications;
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to delete notifications';
  end if;
  raise notice 'ok: clients cannot delete notifications';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8e. The server path reaches all three, including the one no browser may read.
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare wallets int; invites int; notes int;
begin
  select count(*) into wallets from public.wallet_links;
  select count(*) into invites from public.invite_links;
  select count(*) into notes from public.notifications;
  if wallets < 2 or invites < 1 or notes < 2 then
    raise exception
      'service_role saw % wallets, % invites, % notifications; the server paths are blocked',
      wallets, invites, notes;
  end if;
  raise notice 'ok: service_role reads wallet links, invites and notifications';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Clean up. The mutating assertion was rolled back, so only the fixtures
-- remain. Removing them here keeps the guard re-runnable and leaves a shared
-- test database as it was found.
-- ---------------------------------------------------------------------------
delete from public.notifications where user_id in (:user_one, :user_two);
delete from public.wallet_links where user_id in (:user_one, :user_two);
delete from public.invite_links where created_by in (:user_one, :user_two);
delete from public.profiles where user_id in (:user_one, :user_two);
delete from auth.users where id in (:user_one, :user_two);

do $$
begin
  raise notice 'RLS policy guard passed: ownership, column grants and denial all verified.';
end
$$;
