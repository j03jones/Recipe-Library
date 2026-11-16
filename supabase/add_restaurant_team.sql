-- Restaurant teams, part 2 (v0.30.0): who may see the costing, the owner's team list, and a help inbox.
-- Safe to run again. Run after add_restaurant_kitchen.sql.
--
-- Costing (restaurant_kitchen: prices, menu prices, plates) is the owner's to share. Owners always see and change
-- it; each staff member is 'none' (the default), 'view' or 'edit', set by an owner or the admin.
-- Help messages from a restaurant are kept in restaurant_messages for the admin (as well as emailed).

alter table public.restaurant_members add column if not exists costing text not null default 'none';
alter table public.restaurant_members drop constraint if exists restaurant_members_costing_check;
alter table public.restaurant_members add constraint restaurant_members_costing_check check (costing in ('none', 'view', 'edit'));

create or replace function public.can_see_costing(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from public.restaurant_members
    where restaurant_id = p_restaurant and user_id = auth.uid() and (member_role = 'owner' or costing in ('view', 'edit')));
$$;
create or replace function public.can_edit_costing(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.restaurant_active(p_restaurant) and exists (select 1 from public.restaurant_members
    where restaurant_id = p_restaurant and user_id = auth.uid() and (member_role = 'owner' or costing = 'edit')));
$$;
revoke execute on function public.can_see_costing(uuid), public.can_edit_costing(uuid) from public, anon;
grant execute on function public.can_see_costing(uuid), public.can_edit_costing(uuid) to authenticated;

drop policy if exists restaurant_kitchen_read on public.restaurant_kitchen;
create policy restaurant_kitchen_read on public.restaurant_kitchen for select to authenticated
  using (public.can_see_costing(restaurant_id));
drop policy if exists restaurant_kitchen_write on public.restaurant_kitchen;
create policy restaurant_kitchen_write on public.restaurant_kitchen for insert to authenticated
  with check (public.can_edit_costing(restaurant_id));
drop policy if exists restaurant_kitchen_update on public.restaurant_kitchen;
create policy restaurant_kitchen_update on public.restaurant_kitchen for update to authenticated
  using (public.can_edit_costing(restaurant_id)) with check (public.can_edit_costing(restaurant_id));

-- the team as its owners (and the admin) see it: names, emails, roles, costing access
create or replace function public.restaurant_team(p_restaurant uuid)
returns table (user_id uuid, display_name text, email text, member_role text, costing text, joined_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not (public.is_admin() or public.is_owner(p_restaurant)) then
    raise exception 'Only the restaurant''s owners can see the team.';
  end if;
  return query
    select m.user_id, coalesce(p.display_name, ''), coalesce(u.email, '')::text, m.member_role,
           case when m.member_role = 'owner' then 'edit' else m.costing end, u.created_at
    from public.restaurant_members m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
    where m.restaurant_id = p_restaurant
    order by m.member_role desc, coalesce(p.display_name, u.email);
end $$;

-- an owner (or the admin) decides what each staff member may do with the costing
create or replace function public.set_member_costing(p_restaurant uuid, p_user uuid, p_costing text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_owner(p_restaurant)) then
    raise exception 'Only the restaurant''s owners can change who sees the costing.';
  end if;
  if p_costing not in ('none', 'view', 'edit') then raise exception 'Choose none, view or edit.'; end if;
  update public.restaurant_members set costing = p_costing
    where restaurant_id = p_restaurant and user_id = p_user and member_role = 'staff';
  if not found then raise exception 'That person is not on this restaurant''s staff.'; end if;
end $$;
revoke execute on function public.restaurant_team(uuid), public.set_member_costing(uuid, uuid, text) from public, anon;
grant execute on function public.restaurant_team(uuid), public.set_member_costing(uuid, uuid, text) to authenticated;

-- help messages: a member writes one; the admin reads and closes them; the writer can see their own
create table if not exists public.restaurant_messages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null default auth.uid(),
  author_name text not null default '' check (length(author_name) <= 120),
  author_email text not null default '' check (length(author_email) <= 200),
  topic text not null default '' check (length(topic) <= 60),
  body text not null check (length(body) between 1 and 4000),
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists restaurant_messages_open on public.restaurant_messages (restaurant_id, status, created_at desc);

create or replace function public.guard_restaurant_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and not public.is_admin() then
    new.author_id := auth.uid();
    new.status := 'open';
    new.created_at := now();
    if (select count(*) from public.restaurant_messages where author_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
      raise exception 'That is a lot of messages today. Please email hello@jonesridgekitchen.com instead.';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_restaurant_message() from public, anon, authenticated;
drop trigger if exists guard_restaurant_message on public.restaurant_messages;
create trigger guard_restaurant_message before insert on public.restaurant_messages
  for each row execute function public.guard_restaurant_message();

alter table public.restaurant_messages enable row level security;
drop policy if exists restaurant_messages_insert on public.restaurant_messages;
create policy restaurant_messages_insert on public.restaurant_messages for insert to authenticated
  with check (public.is_member(restaurant_id));
drop policy if exists restaurant_messages_read on public.restaurant_messages;
create policy restaurant_messages_read on public.restaurant_messages for select to authenticated
  using (public.is_admin() or author_id = auth.uid());
drop policy if exists restaurant_messages_admin on public.restaurant_messages;
create policy restaurant_messages_admin on public.restaurant_messages for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.restaurant_messages from anon;
grant select, insert, update, delete on public.restaurant_messages to authenticated;

notify pgrst, 'reload schema';
