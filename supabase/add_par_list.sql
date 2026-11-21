-- Par list and daily prep (v0.42.0). Safe to run again. Run after add_restaurant_access.sql.
--
-- A restaurant keeps a par for each prep item (usually one of its recipes), per day of the week. At close, a cook
-- counts what is on hand for each item; that count is for tomorrow, and tomorrow's list is par - on hand. The next day
-- the cooks tap items off as they make them: how much, by whom and when is kept with the day.
--   restaurant_par_items   the items, their pars (Sunday..Saturday) and how many of the item's unit one batch makes
--   restaurant_prep_days   one row per item per day: the par and the count taken the night before, what was made
-- Owners (and the admin) set the items and pars; anyone on the team counts and makes while the plan is on. Counts
-- and makes go through save_par_count and record_prep only, so the par is copied from the item by the database and
-- two cooks tapping at once both count. Cost is worked out in the app from the price book, for those who see costing.

create table if not exists public.restaurant_par_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  recipe_id uuid references public.recipes (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 100),
  unit text not null default 'batch' check (length(unit) between 1 and 30),
  per_batch numeric not null default 1 check (per_batch > 0 and per_batch < 100000),
  station text not null default '' check (length(station) <= 40),
  pars numeric[] not null default '{0,0,0,0,0,0,0}'
    check (cardinality(pars) = 7 and array_position(pars, null) is null and 0 <= all (pars) and 100000 > all (pars)),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists restaurant_par_items_restaurant on public.restaurant_par_items (restaurant_id, sort);

create table if not exists public.restaurant_prep_days (
  item_id uuid not null references public.restaurant_par_items (id) on delete cascade,
  for_date date not null,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  par numeric not null default 0,
  on_hand numeric check (on_hand is null or (on_hand >= 0 and on_hand < 100000)),
  counted_by uuid references auth.users (id) on delete set null,
  counted_name text not null default '',
  counted_at timestamptz,
  made numeric not null default 0 check (made >= 0 and made < 100000),
  made_log jsonb not null default '[]' check (jsonb_typeof(made_log) = 'array'),
  primary key (item_id, for_date)
);
create index if not exists restaurant_prep_days_day on public.restaurant_prep_days (restaurant_id, for_date);

-- up to 300 par items a restaurant; the restaurant can't be changed on an item
create or replace function public.guard_par_item() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.restaurant_id := old.restaurant_id;
    new.created_at := old.created_at;
  elsif (select count(*) from public.restaurant_par_items where restaurant_id = new.restaurant_id) >= 300 then
    raise exception 'This restaurant already has 300 par items.';
  end if;
  if new.recipe_id is not null and not exists (select 1 from public.recipes
       where id = new.recipe_id and scope = 'restaurant' and restaurant_id = new.restaurant_id) then
    raise exception 'That recipe is not in this restaurant''s collection.';
  end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.guard_par_item() from public, anon, authenticated;
drop trigger if exists guard_par_item on public.restaurant_par_items;
create trigger guard_par_item before insert or update on public.restaurant_par_items
  for each row execute function public.guard_par_item();

alter table public.restaurant_par_items enable row level security;
drop policy if exists par_items_read on public.restaurant_par_items;
create policy par_items_read on public.restaurant_par_items for select to authenticated
  using (public.is_admin() or (public.is_member(restaurant_id) and public.restaurant_readable(restaurant_id)));
drop policy if exists par_items_write on public.restaurant_par_items;
create policy par_items_write on public.restaurant_par_items for insert to authenticated
  with check (public.is_admin() or (public.is_owner(restaurant_id) and public.restaurant_active(restaurant_id)));
drop policy if exists par_items_update on public.restaurant_par_items;
create policy par_items_update on public.restaurant_par_items for update to authenticated
  using (public.is_admin() or (public.is_owner(restaurant_id) and public.restaurant_active(restaurant_id)))
  with check (public.is_admin() or (public.is_owner(restaurant_id) and public.restaurant_active(restaurant_id)));
drop policy if exists par_items_delete on public.restaurant_par_items;
create policy par_items_delete on public.restaurant_par_items for delete to authenticated
  using (public.is_admin() or (public.is_owner(restaurant_id) and public.restaurant_active(restaurant_id)));
revoke all on public.restaurant_par_items from anon;
grant select, insert, update, delete on public.restaurant_par_items to authenticated;

alter table public.restaurant_prep_days enable row level security;
drop policy if exists prep_days_read on public.restaurant_prep_days;
create policy prep_days_read on public.restaurant_prep_days for select to authenticated
  using (public.is_admin() or (public.is_member(restaurant_id) and public.restaurant_readable(restaurant_id)));
revoke all on public.restaurant_prep_days from anon, authenticated;
grant select on public.restaurant_prep_days to authenticated;

-- who is doing it, as the team sees them
create or replace function public.prep_name() returns text
language sql stable security definer set search_path = public, auth as $$
  select coalesce(nullif(btrim(p.display_name), ''), split_part(u.email, '@', 1), '')
  from auth.users u left join public.profiles p on p.id = u.id where u.id = auth.uid();
$$;
revoke execute on function public.prep_name() from public, anon, authenticated;

create or replace function public.can_prep(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_member(p_restaurant) and public.restaurant_active(p_restaurant));
$$;
revoke execute on function public.can_prep(uuid) from public, anon;
grant execute on function public.can_prep(uuid) to authenticated;

-- the count at close: p_counts is [{ "item": uuid, "on_hand": number | null }]; the par is that weekday's, copied in.
-- p_date is the day the count is for (tomorrow, in the restaurant's own time), within a couple of days of today.
create or replace function public.save_par_count(p_restaurant uuid, p_date date, p_counts jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare c jsonb; it public.restaurant_par_items; v numeric; n int := 0;
begin
  if not public.can_prep(p_restaurant) then raise exception 'Only this restaurant''s team can count, while the plan is on.'; end if;
  if p_date is null or p_date < current_date - 2 or p_date > current_date + 2 then raise exception 'Counts are for today or tomorrow.'; end if;
  if jsonb_typeof(p_counts) <> 'array' or jsonb_array_length(p_counts) > 300 then raise exception 'That count could not be read.'; end if;
  for c in select * from jsonb_array_elements(p_counts) loop
    select * into it from public.restaurant_par_items
      where id = (c->>'item')::uuid and restaurant_id = p_restaurant;
    if not found then continue; end if;
    v := case when jsonb_typeof(c->'on_hand') = 'number' then (c->>'on_hand')::numeric end;
    if v is not null and (v < 0 or v >= 100000) then raise exception 'A count of % is out of range.', v; end if;
    insert into public.restaurant_prep_days (item_id, for_date, restaurant_id, par, on_hand, counted_by, counted_name, counted_at)
      values (it.id, p_date, p_restaurant, it.pars[extract(dow from p_date)::int + 1], v, auth.uid(), coalesce(public.prep_name(), ''), now())
    on conflict (item_id, for_date) do update
      set par = excluded.par, on_hand = excluded.on_hand, counted_by = excluded.counted_by,
          counted_name = excluded.counted_name, counted_at = excluded.counted_at;
    n := n + 1;
  end loop;
  return n;
end $$;

-- a cook makes some (or takes some back, with a negative amount): added to what was made that day, and logged
create or replace function public.record_prep(p_item uuid, p_date date, p_qty numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare it public.restaurant_par_items; v numeric;
begin
  select * into it from public.restaurant_par_items where id = p_item;
  if not found or not public.can_prep(it.restaurant_id) then raise exception 'Only this restaurant''s team can mark prep, while the plan is on.'; end if;
  if p_date is null or p_date < current_date - 2 or p_date > current_date + 2 then raise exception 'Prep is marked for today.'; end if;
  if p_qty is null or p_qty = 0 or abs(p_qty) >= 100000 then raise exception 'Enter how much was made.'; end if;
  insert into public.restaurant_prep_days (item_id, for_date, restaurant_id, par)
    values (it.id, p_date, it.restaurant_id, it.pars[extract(dow from p_date)::int + 1])
  on conflict (item_id, for_date) do nothing;
  update public.restaurant_prep_days
     set made = greatest(0, made + p_qty),
         made_log = (case when jsonb_array_length(made_log) >= 100 then made_log - 0 else made_log end)
                    || jsonb_build_array(jsonb_build_object('qty', p_qty, 'by', coalesce(public.prep_name(), ''), 'at', now()))
   where item_id = it.id and for_date = p_date
   returning made into v;
  return v;
end $$;
revoke execute on function public.save_par_count(uuid, date, jsonb), public.record_prep(uuid, date, numeric) from public, anon;
grant execute on function public.save_par_count(uuid, date, jsonb), public.record_prep(uuid, date, numeric) to authenticated;

-- live updates for the admin's dashboard and other cooks' screens (Supabase Realtime, where it exists)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'restaurant_prep_days') then
      alter publication supabase_realtime add table public.restaurant_prep_days;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'restaurant_par_items') then
      alter publication supabase_realtime add table public.restaurant_par_items;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
