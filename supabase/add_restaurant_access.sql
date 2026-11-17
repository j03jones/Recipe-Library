-- Restaurant access that comes with consulting (v0.37.0). Safe to run again. Run after add_restaurant_packages.sql
-- and perf_policies_and_indexes.sql.
--
-- Two more packages, set by the admin:
--   advisory  Included with the monthly advisory plan: everything in Managed (Jones Ridge Kitchen keeps the
--             ingredient prices), with no app fee. On while the restaurant's plan is active, like any package.
--   project   Kept after a one-time project (menu costing and pricing, menu development, kitchen
--             standardization), with no monthly payment. The team keeps reading its recipes, and any costing
--             as it was left, whatever the plan's status; nothing can be added or changed, and prices aren't
--             updated. Choosing a monthly package turns the rest back on.
-- Advisory and project restaurants have managed costing, so the price book guard keeps the prices as they are.

alter table public.restaurants drop constraint if exists restaurants_package_check;
alter table public.restaurants add constraint restaurants_package_check
  check (package in ('small', 'self_service', 'managed', 'advisory', 'project'));

create or replace function public.restaurant_package_costing() returns trigger
language plpgsql set search_path = public as $$
begin
  new.costing_tier := case when new.package in ('managed', 'advisory', 'project') then 'managed' else 'self_service' end;
  return new;
end $$;
revoke execute on function public.restaurant_package_costing() from public, anon, authenticated;
update public.restaurants set package = package where package in ('advisory', 'project');   -- costing in step

-- writing (adding recipes, changing the price book) needs an active plan, never on a project restaurant
create or replace function public.restaurant_active(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurants
                 where id = p_restaurant and package <> 'project'
                   and (subscription_status = 'active'
                        or (subscription_status = 'trialing' and (trial_ends_at is null or trial_ends_at > now()))));
$$;

-- reading the collection: an active plan, or a project restaurant (kept with no monthly payment)
create or replace function public.restaurant_readable(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.restaurant_active(p_restaurant)
      or exists (select 1 from public.restaurants where id = p_restaurant and package = 'project');
$$;
revoke execute on function public.restaurant_readable(uuid) from public, anon;
grant execute on function public.restaurant_readable(uuid) to authenticated;

-- a project restaurant's team are not paying members (the free plan's private recipe limit still applies)
create or replace function public.is_paid(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurant_members m
                 join public.restaurants r on r.id = m.restaurant_id
                 where m.user_id = p_user and r.package <> 'project'
                   and (r.subscription_status = 'active'
                        or (r.subscription_status = 'trialing' and (r.trial_ends_at is null or r.trial_ends_at > now()))));
$$;

alter policy recipes_read on public.recipes using (
  is_admin() or (owner_id = (select auth.uid()))
  or ((scope = 'community') and (status = 'approved'))
  or ((scope = 'restaurant') and is_member(restaurant_id) and restaurant_readable(restaurant_id)));

notify pgrst, 'reload schema';
