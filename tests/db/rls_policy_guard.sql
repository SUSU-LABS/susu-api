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

-- A contract address and a classic account address, for the registration shape
-- assertions. The same values the fixtures use, so a failure here refers to the
-- same address a unit test would.
\set group_contract_id '''CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'''
\set account_address '''GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'''

-- Two avatar objects, one per user, in the shape the app produces: a generated
-- 32-character hex name under the user's own prefix.
\set avatar_one '''users/11111111-1111-1111-1111-111111111111/avatar/11111111111111111111111111111111.png'''
\set avatar_two '''users/22222222-2222-2222-2222-222222222222/avatar/22222222222222222222222222222222.png'''

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

-- The registration assertions below need a contract address, a classic account
-- address and a second user inside `do $$` blocks, where psql does not
-- substitute. Republished here for the same reason, and from the same values.
select set_config('guard.group_contract_id', :group_contract_id, false),
       set_config('guard.account_address', :account_address, false),
       set_config('guard.user_two', :user_two, false);

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

-- Fixtures for the two server-only tables added with the wallet and invite
-- flows. A denial assertion against an empty table proves nothing: it passes
-- whether the privilege is absent or the table is simply empty, so both tables
-- are given a row the browser roles must not be able to reach.
insert into public.wallet_link_nonces (jti, user_id, expires_at) values
  ('guardnonceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', :user_one, now() + interval '5 minutes')
on conflict (jti) do nothing;

-- References the invite by its code rather than by a hard-coded id, so the
-- redemption cannot silently stop pointing at the invite under test.
insert into public.invite_redemptions (invite_id, user_id)
select i.id, :user_two from public.invite_links i where i.code = :invite_code
on conflict do nothing;

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

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.wallet_link_nonces;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'anon was able to read public.wallet_link_nonces';
  end if;
  raise notice 'ok: anon cannot read spent nonces';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.invite_redemptions;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'anon was able to read public.invite_redemptions';
  end if;
  raise notice 'ok: anon cannot read invite redemptions';
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

-- ---------------------------------------------------------------------------
-- 8e. Spent nonces and invite redemptions are server-only.
--
-- Both tables exist to hold a fact the client must not be able to assert: that a
-- nonce has been spent, and that a user has consumed a use of an invite. So the
-- assertion here is denial for every operation, including select — a client that
-- could read this data learns which nonces exist, and one that could write it
-- defeats the control the table was created for.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.wallet_link_nonces;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'an authenticated user read spent nonces';
  end if;
  raise notice 'ok: authenticated users cannot read spent nonces';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.wallet_link_nonces (jti, user_id, expires_at)
    values ('clientchosenid0000000000000000000000', current_setting('guard.user_id')::uuid,
            now() + interval '5 minutes');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client was able to write a spent nonce, which it could replay to deny itself';
  end if;
  raise notice 'ok: clients cannot write spent nonces';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.invite_redemptions;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'an authenticated user read invite redemptions';
  end if;
  raise notice 'ok: authenticated users cannot read invite redemptions';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.invite_redemptions (invite_id, user_id)
    select id, current_setting('guard.user_id')::uuid from public.invite_links limit 1;
  exception when insufficient_privilege then
    denied := true;
  end;

    if not denied then
    raise exception 'a client was able to record a redemption, which would burn an invite''s uses';
  end if;
  raise notice 'ok: clients cannot record invite redemptions';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8f. Group registrations are server-only, in both directions.
--
-- The claim itself is not a secret — it is an address the chain already
-- published — but the *set* of them is: it is the list of addresses this API
-- currently believes are groups without the index having confirmed it, which is
-- exactly the list worth presenting to an invite endpoint. So no browser role
-- reads it and none writes it; the client learns the outcome of its own
-- registration from the response to the write, and nothing else.
--
-- The shape constraints are asserted here too. They are the last place a
-- malformed address or a window that is already over can be refused, and a
-- registration that is born expired would read as a success and behave as a
-- failure.
-- ---------------------------------------------------------------------------
set role anon;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.group_registrations;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'an anonymous user read group registrations';
  end if;
  raise notice 'ok: anonymous users cannot read group registrations';
end
$$;

reset role;
set role authenticated;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.group_registrations;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'an authenticated user read group registrations';
  end if;
  raise notice 'ok: authenticated users cannot read group registrations';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.group_registrations (contract_id, registered_by, expires_at)
    values (current_setting('guard.group_contract_id'), current_setting('guard.user_id')::uuid,
            now() + interval '10 minutes');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a client registered a group, which could hold the window open on its own';
  end if;
  raise notice 'ok: clients cannot register groups';
end
$$;

reset role;

-- The shape constraints, exercised as the role that does write these rows.
set role service_role;

do $$
declare refused boolean := false;
begin
  -- A classic account address. A group is a contract, so this could never
  -- resolve, and the database refuses it rather than storing a claim that cannot
  -- become true.
  begin
    insert into public.group_registrations (contract_id, registered_by, expires_at)
    values (current_setting('guard.account_address'), current_setting('guard.user_id')::uuid,
            now() + interval '10 minutes');
  exception when check_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'a non-contract address was stored as a group registration';
  end if;
  raise notice 'ok: registrations are refused for anything but a contract address';
end
$$;

do $$
declare refused boolean := false;
begin
  -- An inverted window: the claim would end before it began. This is the window
  -- the table can refuse in a constraint. A window that is merely stale cannot be
  -- — `now()` is not immutable, so it has no place in a CHECK — which is why the
  -- read predicate filters on it instead, and why the store computes the expiry
  -- rather than accepting one.
  begin
    insert into public.group_registrations (contract_id, registered_by, created_at, expires_at)
    values (current_setting('guard.group_contract_id'), current_setting('guard.user_two')::uuid,
            now(), now() - interval '1 hour');
  exception when check_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'a registration whose window ends before it starts was accepted';
  end if;
  raise notice 'ok: registrations are refused when their window is inverted';
end
$$;

do $$
begin
  insert into public.group_registrations (contract_id, registered_by, expires_at)
  values (current_setting('guard.group_contract_id'), current_setting('guard.user_id')::uuid,
          now() + interval '30 minutes')
  on conflict (contract_id) do nothing;

  if not exists (
    select 1 from public.group_registrations
    where contract_id = current_setting('guard.group_contract_id') and expires_at > now()
  ) then
    raise exception 'the server could not register a group, so the invite window cannot be bridged';
  end if;
  raise notice 'ok: the server path registers groups';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8g. The server path reaches all of these, including the tables no browser may
--     read. `service_role` is the role the API connects as, so a deny here would
--     mean the wallet, invite and registration flows could not work at all.
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare wallets int; invites int; notes int; nonces int; redemptions int; registrations int;
begin
  select count(*) into wallets from public.wallet_links;
  select count(*) into invites from public.invite_links;
  select count(*) into notes from public.notifications;
  select count(*) into nonces from public.wallet_link_nonces;
  select count(*) into redemptions from public.invite_redemptions;
  select count(*) into registrations from public.group_registrations;
  if wallets < 2 or invites < 1 or notes < 2 then
    raise exception
      'service_role saw % wallets, % invites, % notifications; the server paths are blocked',
      wallets, invites, notes;
  end if;
  if nonces < 1 or redemptions < 1 then
    raise exception
      'service_role saw % nonce(s) and % redemption(s); the wallet and invite flows are blocked',
      nonces, redemptions;
  end if;
  if registrations < 1 then
    raise exception
      'service_role saw no group registrations; a creator could not invite anyone until the indexer caught up';
  end if;
  raise notice
    'ok: service_role reaches wallet links, invites, notifications, nonces, redemptions and registrations';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8h. Profile images: one private bucket, and objects reachable only by their
--     owner.
--
--     The bucket is checked first, and the table privileges are asserted before
--     any denial. The ordering is deliberate: a hosted project grants `anon` and
--     `authenticated` broad privileges on `storage.objects` and relies on RLS
--     alone, so a denial here is a policy denial. If the grant were missing the
--     same denial would appear from the wrong cause, and the guard would pass
--     while the policies said anything at all.
-- ---------------------------------------------------------------------------
do $$
declare problem text;
begin
  select case
           when b.public is not false then 'the bucket is public'
           when coalesce(b.file_size_limit, 0) <> 2097152 then 'the size limit is not 2 MiB'
           when not (b.allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp'])
             then 'the MIME allow-list does not contain the three image types'
           else null
         end
    into problem
  from storage.buckets b
  where b.id = 'profile-images';

  if not found then
    raise exception 'the profile-images bucket does not exist, so no profile image can be stored';
  end if;
  if problem is not null then
    raise exception 'profile-images: %', problem;
  end if;
  raise notice 'ok: profile-images is private, capped at 2 MiB, and limited to three image types';
end
$$;

do $$
begin
  if not has_table_privilege('authenticated', 'storage.objects', 'INSERT')
     or not has_table_privilege('authenticated', 'storage.objects', 'SELECT')
     or not has_table_privilege('anon', 'storage.objects', 'SELECT') then
    raise exception
      'storage.objects privileges are narrower than a hosted project grants, so the denials below would not be policy denials';
  end if;
  raise notice 'ok: storage.objects grants are broad, as on a hosted project';
end
$$;

-- Two objects, one per user, written by the connecting role so that both exist
-- for the cross-user assertions.
insert into storage.objects (bucket_id, name) values
  ('profile-images', :avatar_one),
  ('profile-images', :avatar_two)
on conflict (bucket_id, name) do nothing;

select set_config('guard.avatar_one', :avatar_one, false),
       set_config('guard.avatar_two', :avatar_two, false);

select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare listed int; refused boolean := false;
begin
  select count(*) into listed from storage.objects;
  if listed <> 0 then
    raise exception 'anon can list % storage object(s)', listed;
  end if;

  begin
    insert into storage.objects (bucket_id, name)
    values ('profile-images', current_setting('guard.avatar_one'));
  exception when insufficient_privilege then
    refused := true;
  end;

  if not refused then
    raise exception 'anon uploaded a profile image';
  end if;
  raise notice 'ok: anon can neither list nor upload a profile image';
end
$$;

reset role;
select set_config('request.jwt.claim.sub', :user_one, false);
set role authenticated;

do $$
declare mine int; theirs int;
begin
  -- Their own object, and only it. `theirs` is read by exact name, so this is a
  -- statement about RLS rather than about not being able to guess a path.
  select count(*) into mine from storage.objects where name = current_setting('guard.avatar_one');
  select count(*) into theirs from storage.objects where name = current_setting('guard.avatar_two');

  if mine <> 1 then
    raise exception 'a user could not read their own profile image';
  end if;
  if theirs <> 0 then
    raise exception 'a user can read another user''s profile image';
  end if;
  raise notice 'ok: a user reads their own profile image and not another user''s';
end
$$;

do $$
declare refused boolean := false;
begin
  -- Writing under someone else's prefix. The `with check` clause is what refuses
  -- this; without it the insert would be permitted and the object would land in
  -- a folder its owner cannot reach.
  begin
    insert into storage.objects (bucket_id, name)
    values ('profile-images', 'users/22222222-2222-2222-2222-222222222222/avatar/33333333333333333333333333333333.png');
  exception when insufficient_privilege then
    refused := true;
  end;

  if not refused then
    raise exception 'a user uploaded into another user''s prefix';
  end if;
  raise notice 'ok: a user cannot upload into another user''s prefix';
end
$$;

do $$
declare refused boolean := false;
begin
  -- A path under the user's *own* prefix but outside `avatar/`. The ownership
  -- check alone would permit it, so this is the assertion that the policy is
  -- scoped to the segment the app actually uses rather than the whole prefix.
  begin
    insert into storage.objects (bucket_id, name)
    values ('profile-images', 'users/11111111-1111-1111-1111-111111111111/other/99999999999999999999999999999999.png');
  exception when insufficient_privilege then
    refused := true;
  end;

  if not refused then
    raise exception 'a user uploaded outside the avatar/ segment under their own prefix';
  end if;
  raise notice 'ok: a user cannot write outside the avatar/ segment';
end
$$;

do $$
declare removed int; moved int;
begin
  -- Deleting and renaming someone else's object affect zero rows rather than
  -- raising, because RLS filters the rows a statement may see.
  delete from storage.objects where name = current_setting('guard.avatar_two');
  get diagnostics removed = row_count;

  update storage.objects set name = 'users/11111111-1111-1111-1111-111111111111/avatar/44444444444444444444444444444444.png'
  where name = current_setting('guard.avatar_two');
  get diagnostics moved = row_count;

  if removed <> 0 or moved <> 0 then
    raise exception 'a user reached another user''s object (deleted %, renamed %)', removed, moved;
  end if;
  raise notice 'ok: a user cannot delete or rename another user''s object';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 8i. `avatar_path` may only name the user's own object, in the shape this app
--     produces. The column is writable by the browser, so this is the check that
--     cannot be bypassed by a second writer or a future endpoint that forgot to
--     validate.
-- ---------------------------------------------------------------------------
begin;

select set_config('request.jwt.claim.sub', :user_one, false);
set role authenticated;

do $$
declare accepted int;
begin
  update public.profiles
  set avatar_path = 'users/11111111-1111-1111-1111-111111111111/avatar/55555555555555555555555555555555.webp'
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics accepted = row_count;

  if accepted <> 1 then
    raise exception 'a user could not set their own avatar path';
  end if;
  raise notice 'ok: a user sets an avatar path in their own prefix';
end
$$;

do $$
declare
  names text[] := array[
    -- A name the uploader chose rather than one this app generated.
    'users/11111111-1111-1111-1111-111111111111/avatar/photo.png',
    -- A format the bucket does not accept.
    'users/11111111-1111-1111-1111-111111111111/avatar/66666666666666666666666666666666.gif',
    -- Another user's prefix: an object this user can neither read nor delete.
    'users/22222222-2222-2222-2222-222222222222/avatar/77777777777777777777777777777777.png',
    -- Traversal, which would resolve outside the prefix the policies match on.
    'users/11111111-1111-1111-1111-111111111111/avatar/../../22222222-2222-2222-2222-222222222222/avatar/88888888888888888888888888888888.png',
    -- An absolute URL, which is the mistake this column exists to prevent.
    'https://example.com/photo.png'
  ];
  candidate text;
  refused boolean;
begin
  foreach candidate in array names loop
    refused := false;
    begin
      update public.profiles
      set avatar_path = candidate
      where user_id = '11111111-1111-1111-1111-111111111111';
    exception when check_violation then
      refused := true;
    end;

    if not refused then
      raise exception 'avatar_path accepted %', candidate;
    end if;
  end loop;
  raise notice 'ok: avatar_path refuses names it did not generate, other users'' prefixes, and traversal';
end
$$;

rollback;

reset role;

-- ---------------------------------------------------------------------------
-- 8j. The server path reaches the bucket as well: cleaning up a deleted
--     account's photo is the API's job, because the browser of a deleted account
--     no longer exists to do it.
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id = 'profile-images';
  if n < 2 then
    raise exception 'service_role saw % profile image(s); the server could not clean them up', n;
  end if;
  raise notice 'ok: service_role reaches profile images';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Clean up. The mutating assertion was rolled back, so only the fixtures
-- remain. Removing them here keeps the guard re-runnable and leaves a shared
-- test database as it was found.
-- ---------------------------------------------------------------------------
delete from public.group_registrations where registered_by in (:user_one, :user_two);
delete from storage.objects where name in (:avatar_one, :avatar_two);
delete from public.invite_redemptions
  where invite_id in (select id from public.invite_links where created_by in (:user_one, :user_two));
delete from public.wallet_link_nonces where user_id in (:user_one, :user_two);
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
