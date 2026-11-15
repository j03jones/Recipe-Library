-- Households: a shopping list shared by the people you live with. Everyone in a household sees and
-- changes the same list. Run after add_delete_own_account.sql (safe to run again). New projects get this
-- from schema.sql.
--
-- A person belongs to at most one household. One person makes it (create_household) and gets a short
-- code; others join with it (join_household). The list is one JSON document (the app's shopping list:
-- items, extras, done); each phone merges its own changes into the latest copy before saving, so two
-- people ticking things off at once don't undo each other.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  code text not null unique,
  list jsonb not null default '{}' check (jsonb_typeof(list) = 'object' and pg_column_size(list) <= 262144),
  list_at bigint not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists household_members_household on public.household_members (household_id);

alter table public.households enable row level security;
alter table public.household_members enable row level security;

create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;

drop policy if exists households_member_read on public.households;
create policy households_member_read on public.households for select to authenticated using (id = public.my_household());
drop policy if exists household_members_read on public.household_members;
create policy household_members_read on public.household_members for select to authenticated using (household_id = public.my_household());
-- no insert/update/delete policies: everything goes through the functions below

-- Make a household with you in it. Returns its join code.
create or replace function public.create_household(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if public.my_household() is not null then raise exception 'You are already in a household. Leave it first.'; end if;
  loop
    v_code := upper(substr(translate(replace(gen_random_uuid()::text, '-', ''), '01', ''), 1, 6));   -- no 0/1 to misread
    exit when char_length(v_code) = 6 and not exists (select 1 from public.households where code = v_code);
  end loop;
  insert into public.households (name, code, created_by) values (left(trim(coalesce(p_name, '')), 60), v_code, auth.uid())
    returning id into v_id;
  insert into public.household_members (user_id, household_id) values (auth.uid(), v_id);
  return v_code;
end $$;

-- Join the household with this code (at most 8 people).
create or replace function public.join_household(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if public.my_household() is not null then raise exception 'You are already in a household. Leave it first.'; end if;
  select id into v_id from public.households where code = upper(trim(coalesce(p_code, '')));
  if v_id is null then raise exception 'No household has that code. Check it and try again.'; end if;
  if (select count(*) from public.household_members where household_id = v_id) >= 8 then
    raise exception 'That household is full (8 people).';
  end if;
  insert into public.household_members (user_id, household_id) values (auth.uid(), v_id);
end $$;

-- Leave your household. The last one out takes the household (and its list) with them.
create or replace function public.leave_household() returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid := public.my_household();
begin
  if v_id is null then return; end if;
  delete from public.household_members where user_id = auth.uid();
  delete from public.households h where h.id = v_id
    and not exists (select 1 from public.household_members m where m.household_id = v_id);
end $$;

-- Your household's name, code, list and who's in it (first names only), or no row.
create or replace function public.household_info() returns table (id uuid, name text, code text, list jsonb, list_at bigint, members text[])
language sql stable security definer set search_path = public as $$
  select h.id, h.name, h.code, h.list, h.list_at,
         coalesce(array_agg(coalesce(nullif(split_part(p.display_name, ' ', 1), ''), 'Someone') order by m.joined_at), '{}')
  from public.households h
  join public.household_members m on m.household_id = h.id
  left join public.profiles p on p.id = m.user_id
  where h.id = public.my_household()
  group by h.id
$$;

-- Save the shared list (the phone has already merged its changes into the latest copy).
create or replace function public.save_household_list(p_list jsonb, p_at bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_household() is null then raise exception 'You are not in a household.'; end if;
  if jsonb_typeof(p_list) <> 'object' then raise exception 'Not a shopping list.'; end if;
  update public.households set list = p_list, list_at = greatest(list_at + 1, p_at) where id = public.my_household();
end $$;

revoke execute on function public.my_household(), public.create_household(text), public.join_household(text),
  public.leave_household(), public.household_info(), public.save_household_list(jsonb, bigint) from public, anon;
grant execute on function public.my_household(), public.create_household(text), public.join_household(text),
  public.leave_household(), public.household_info(), public.save_household_list(jsonb, bigint) to authenticated;

-- deleting your account also leaves your household (and removes it if you were the last one in)
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
  perform public.leave_household();
  delete from public.recipes where owner_id = v_me;
  delete from auth.users where id = v_me;
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
