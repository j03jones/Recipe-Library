-- Restaurant teams add their own recipes, and keep one price book for costing (v0.29.0). Safe to run again.
-- Run after add_restaurant_trials.sql.
--
-- Recipes in a restaurant's collection come from two places:
--   the chef (the admin) adds them: the restaurant's team can read them, never change or delete them;
--   the team adds its own: owners and staff can add while the plan is on; staff can change or delete the
--   ones they added, owners any the team added.
-- Each restaurant has one shared price book (restaurant_kitchen.prices, the app's own shape:
-- { items: { food: { p, per } }, menu: { recipe id: menu price }, portions: { recipe id: n }, target: % }).

create or replace function public.is_admin_user(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user and role = 'admin');
$$;
revoke execute on function public.is_admin_user(uuid) from public, anon;
grant execute on function public.is_admin_user(uuid) to authenticated;

drop policy if exists recipes_kitchen_insert on public.recipes;
create policy recipes_kitchen_insert on public.recipes for insert to authenticated
  with check (scope = 'restaurant' and owner_id = auth.uid() and status = 'approved'
              and public.is_member(restaurant_id) and public.restaurant_active(restaurant_id));

drop policy if exists recipes_kitchen_update on public.recipes;
create policy recipes_kitchen_update on public.recipes for update to authenticated
  using (scope = 'restaurant' and public.is_member(restaurant_id) and public.restaurant_active(restaurant_id)
         and not public.is_admin_user(owner_id) and (owner_id = auth.uid() or public.is_owner(restaurant_id)))
  with check (scope = 'restaurant' and public.is_member(restaurant_id));

drop policy if exists recipes_kitchen_delete on public.recipes;
create policy recipes_kitchen_delete on public.recipes for delete to authenticated
  using (scope = 'restaurant' and public.is_member(restaurant_id) and public.restaurant_active(restaurant_id)
         and not public.is_admin_user(owner_id) and (owner_id = auth.uid() or public.is_owner(restaurant_id)));

-- a restaurant's team can keep up to 2,000 recipes of its own
create or replace function public.limit_kitchen_recipes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.scope = 'restaurant' and not public.is_admin()
     and (select count(*) from public.recipes r where r.restaurant_id = new.restaurant_id and r.scope = 'restaurant'
          and not public.is_admin_user(r.owner_id)) >= 2000 then
    raise exception 'This restaurant already has 2,000 recipes of its own.';
  end if;
  return new;
end $$;
revoke execute on function public.limit_kitchen_recipes() from public, anon, authenticated;
drop trigger if exists limit_kitchen_recipes on public.recipes;
create trigger limit_kitchen_recipes before insert on public.recipes
  for each row execute function public.limit_kitchen_recipes();

create table if not exists public.restaurant_kitchen (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  prices jsonb not null default '{}' check (jsonb_typeof(prices) = 'object' and pg_column_size(prices) < 1000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create or replace function public.touch_restaurant_kitchen() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
revoke execute on function public.touch_restaurant_kitchen() from public, anon, authenticated;
drop trigger if exists restaurant_kitchen_touch on public.restaurant_kitchen;
create trigger restaurant_kitchen_touch before insert or update on public.restaurant_kitchen
  for each row execute function public.touch_restaurant_kitchen();

alter table public.restaurant_kitchen enable row level security;
drop policy if exists restaurant_kitchen_read on public.restaurant_kitchen;
create policy restaurant_kitchen_read on public.restaurant_kitchen for select to authenticated
  using (public.is_admin() or public.is_member(restaurant_id));
drop policy if exists restaurant_kitchen_write on public.restaurant_kitchen;
create policy restaurant_kitchen_write on public.restaurant_kitchen for insert to authenticated
  with check (public.is_admin() or (public.is_member(restaurant_id) and public.restaurant_active(restaurant_id)));
drop policy if exists restaurant_kitchen_update on public.restaurant_kitchen;
create policy restaurant_kitchen_update on public.restaurant_kitchen for update to authenticated
  using (public.is_admin() or (public.is_member(restaurant_id) and public.restaurant_active(restaurant_id)))
  with check (public.is_admin() or (public.is_member(restaurant_id) and public.restaurant_active(restaurant_id)));
revoke all on public.restaurant_kitchen from anon;
grant select, insert, update on public.restaurant_kitchen to authenticated;

notify pgrst, 'reload schema';
