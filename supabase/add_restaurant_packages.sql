-- Restaurant packages (v0.36.0). Safe to run again. Run after add_costing_tiers.sql.
--
-- What a restaurant signed up for, as sold on jonesridgekitchen.com/restaurant-app/:
--   small         Small business: food trucks and small vendors; the recipe app and self-service costing, 2 logins
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

notify pgrst, 'reload schema';
