-- Restaurant packages (v0.36.0). Safe to run again. Run after add_costing_tiers.sql.
--
-- What a restaurant signed up for, as sold on jonesridgekitchen.com/restaurant-app/:
--   small         Small business: food trucks and small vendors; self-service costing, 1 login, 50 recipes of their own
--   self_service  Self-service: the recipe app and costing the team keeps itself, 3 logins
--   managed       Managed: Jones Ridge Kitchen keeps the ingredient prices, 5 logins (the premium package)
-- The package decides the costing tier (only Managed is 'managed'), kept in step by a trigger, so the price book
-- guard from add_costing_tiers.sql keeps working unchanged. Self-service is now the default for new restaurants.
-- Existing restaurants keep their costing as it is: managed ones become Managed, the rest Self-service.

alter table public.restaurants add column if not exists package text;
update public.restaurants set package = case when costing_tier = 'managed' then 'managed' else 'self_service' end where package is null;
alter table public.restaurants alter column package set default 'self_service';
alter table public.restaurants alter column package set not null;
alter table public.restaurants drop constraint if exists restaurants_package_check;
alter table public.restaurants add constraint restaurants_package_check check (package in ('small', 'self_service', 'managed'));
alter table public.restaurants alter column costing_tier set default 'self_service';

create or replace function public.restaurant_package_costing() returns trigger
language plpgsql set search_path = public as $$
begin
  new.costing_tier := case when new.package = 'managed' then 'managed' else 'self_service' end;
  return new;
end $$;
revoke execute on function public.restaurant_package_costing() from public, anon, authenticated;
drop trigger if exists restaurant_package_costing on public.restaurants;
create trigger restaurant_package_costing before insert or update on public.restaurants
  for each row execute function public.restaurant_package_costing();

-- Small business holds 50 recipes the team adds itself (the chef's recipes don't count); the others up to 2,000.
create or replace function public.limit_kitchen_recipes() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cap int;
begin
  if new.scope = 'restaurant' and not public.is_admin() then
    v_cap := case (select package from public.restaurants where id = new.restaurant_id) when 'small' then 50 else 2000 end;
    if (select count(*) from public.recipes r where r.restaurant_id = new.restaurant_id and r.scope = 'restaurant'
        and not public.is_admin_user(r.owner_id)) >= v_cap then
      raise exception '%', case when v_cap = 50
        then 'The Small business plan holds 50 recipes of your own. To add more, move to Self-service: ask Joseph.'
        else 'This restaurant already has 2,000 recipes of its own.' end;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.limit_kitchen_recipes() from public, anon, authenticated;

notify pgrst, 'reload schema';
