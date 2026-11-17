-- Costing tiers for restaurants (v0.35.0). Safe to run again. Run after add_restaurant_team.sql and add_recipe_versions.sql.
--
-- Costing is a service. On the default tier, 'managed', Jones Ridge Kitchen keeps the restaurant's ingredient
-- prices (restaurant_kitchen.prices -> 'items'); the restaurant's logins see every cost but cannot change those
-- prices or import a supplier list. Their target food cost %, menu prices, portions and plates stay theirs (as the
-- owner allows each login). 'self_service', the consultation tier, lets them keep their own prices too.
-- Only the admin can change a restaurant's tier (restaurants is admin-write only).

alter table public.restaurants add column if not exists costing_tier text not null default 'managed';
alter table public.restaurants drop constraint if exists restaurants_costing_tier_check;
alter table public.restaurants add constraint restaurants_costing_tier_check check (costing_tier in ('managed', 'self_service'));

-- On a managed restaurant, a save from anyone but the admin keeps the ingredient prices as they were, whatever it
-- sends; everything else in the price book is saved as usual.
create or replace function public.guard_kitchen_prices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin()
     and coalesce((select costing_tier from public.restaurants where id = new.restaurant_id), 'managed') = 'managed' then
    new.prices := jsonb_set(new.prices, '{items}',
      coalesce(case when tg_op = 'UPDATE' then old.prices -> 'items' end, '{}'::jsonb), true);
  end if;
  return new;
end $$;
revoke execute on function public.guard_kitchen_prices() from public, anon, authenticated;
drop trigger if exists guard_kitchen_prices on public.restaurant_kitchen;
create trigger guard_kitchen_prices before insert or update on public.restaurant_kitchen
  for each row execute function public.guard_kitchen_prices();

notify pgrst, 'reload schema';
