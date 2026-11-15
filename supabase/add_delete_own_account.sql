-- Let a signed-in person delete their own account (required by the App Store and Google Play).
-- Run after tighten_function_access.sql (safe to run again). New projects get this from schema.sql.
--
-- Everything of theirs goes with the account: their profile, private recipes, recipes they shared to
-- Community, starred recipes, meal plan and shopping list (all cascade from auth.users). The app deletes
-- their photos from Storage first. The administrator account cannot delete itself, and the only owner of
-- a restaurant has to hand ownership on first so the restaurant's staff are not left without one.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Please sign in first.'; end if;
  if (select role from public.profiles where id = v_me) = 'admin' then
    raise exception 'The administrator account cannot be deleted from the app.';
  end if;
  if exists (select 1 from public.restaurant_members m
             where m.user_id = v_me and m.member_role = 'owner'
               and (select count(*) from public.restaurant_members o
                    where o.restaurant_id = m.restaurant_id and o.member_role = 'owner') <= 1) then
    raise exception 'You are the only owner of a restaurant. Make someone else an owner first, or ask the admin.';
  end if;
  delete from public.recipes where owner_id = v_me;
  delete from auth.users where id = v_me;
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
