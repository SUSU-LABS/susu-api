-- Susu Protocol — scope the profile-image policies to the avatar/ segment.
--
-- WHY THIS EXISTS
-- `0004_profile_images.sql` scoped each policy to `users/<uid>/`, so a signed-in
-- user could write unbounded objects anywhere under their own prefix —
-- `users/<uid>/anything/<name>` — and only the app's client-side path shape kept
-- uploads inside `avatar/`. The ownership boundary was right; the segment was
-- missing. This migration re-creates the four policies with a third-segment
-- check so only `users/<uid>/avatar/<name>` is reachable. Account deletion then
-- lists only `avatar/`, so a path outside it is an object nobody can write, read
-- or clean up.
--
-- Written as drop-then-create so re-applying converges, and guarded on
-- `storage.objects` existing so a plain PostgreSQL (as used by the CI guards)
-- treats it as a no-op rather than a failure.
--> statement-breakpoint
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'profile-images: storage.objects absent — skipping policy tightening.';
    return;
  end if;

  execute 'drop policy if exists profile_images_select_own on storage.objects';
  execute $policy$
    create policy profile_images_select_own on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[3] = 'avatar'
      )
  $policy$;

  execute 'drop policy if exists profile_images_insert_own on storage.objects';
  execute $policy$
    create policy profile_images_insert_own on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[3] = 'avatar'
      )
  $policy$;

  -- Update is what `upsert` uses. Both clauses are required: without `with check`
  -- a user could move an object they own into another user's prefix, which would
  -- hand it to them and take it out of the owner's reach.
  execute 'drop policy if exists profile_images_update_own on storage.objects';
  execute $policy$
    create policy profile_images_update_own on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[3] = 'avatar'
      )
      with check (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[3] = 'avatar'
      )
  $policy$;

  execute 'drop policy if exists profile_images_delete_own on storage.objects';
  execute $policy$
    create policy profile_images_delete_own on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'profile-images'
        and (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[3] = 'avatar'
      )
  $policy$;
end
$$;
