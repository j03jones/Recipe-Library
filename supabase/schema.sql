-- Jones Ridge recipe library: database setup for Supabase.
--
-- HOW TO RUN (once, on a new project):
--   1. Change the email on the line marked  CHANGE ME  to the email you will sign up with as admin.
--   2. Supabase dashboard > SQL Editor > New query > paste this whole file > Run.
--   3. Right away, sign up in the app with that same email (turn "Confirm email" ON in
--      Authentication > Providers > Email so nobody else can claim it).
--
-- WHO CAN SEE WHAT (enforced here, in the database, not in the app):
--   admin     everything
--   student   own private recipes + approved Community recipes
--   client    the same, plus their restaurant's collection while the subscription is active
--
-- Safe to re-run on an empty project only. Do not run it on a database that already holds data.

-- ----------------------------------------------------------------------------- settings
create table public.app_settings (
  id boolean primary key default true check (id),      -- exactly one row
  admin_email text not null,
  open_signup boolean not null default false,           -- false = invite code required
  free_recipe_limit int not null default 25 check (free_recipe_limit >= 0)
);
insert into public.app_settings (admin_email) values ('CHANGE-ME@example.com');   -- CHANGE ME

-- ----------------------------------------------------------------------------- people
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role text not null default 'student' check (role in ('admin', 'student', 'client')),
  created_at timestamptz not null default now()
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  subscription_status text not null default 'inactive'
    check (subscription_status in ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  seat_limit int not null default 3 check (seat_limit >= 1),
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table public.restaurant_members (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  member_role text not null default 'staff' check (member_role in ('owner', 'staff')),
  primary key (restaurant_id, user_id)
);
create index on public.restaurant_members (user_id);

create table public.invites (
  code text primary key check (code = upper(code) and length(code) >= 8),
  kind text not null check (kind in ('student', 'restaurant')),
  restaurant_id uuid references public.restaurants (id) on delete cascade,
  member_role text not null default 'staff' check (member_role in ('owner', 'staff')),
  max_uses int not null default 1 check (max_uses >= 1),
  uses int not null default 0,
  expires_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'restaurant') = (restaurant_id is not null))
);

-- ----------------------------------------------------------------------------- recipes
-- scope  private     only the owner
--        restaurant  a collection the admin built for one restaurant
--        community   a copy a student shared; visible to everyone once approved
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  restaurant_id uuid references public.restaurants (id) on delete cascade,
  scope text not null check (scope in ('private', 'restaurant', 'community')),
  status text not null default 'approved' check (status in ('pending', 'approved', 'declined')),
  title text not null check (length(title) between 1 and 300),
  categories text[] not null default '{}',
  body jsonb not null,                       -- the app's own recipe record (ingredients, directions, yield, tags)
  source_recipe_id uuid references public.recipes (id) on delete set null,
  author_name text,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'restaurant') = (restaurant_id is not null)),
  check (scope = 'community' or status = 'approved')
);
create index on public.recipes (owner_id);
create index on public.recipes (restaurant_id) where restaurant_id is not null;
create index on public.recipes (scope, status);
-- a recipe can only be waiting or live in Community once (declined ones may be re-submitted)
create unique index recipes_one_open_submission on public.recipes (source_recipe_id)
  where scope = 'community' and status in ('pending', 'approved');

-- ----------------------------------------------------------------------------- helpers
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create function public.is_member(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurant_members
                 where restaurant_id = p_restaurant and user_id = auth.uid());
$$;

create function public.is_owner(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurant_members
                 where restaurant_id = p_restaurant and user_id = auth.uid() and member_role = 'owner');
$$;

create function public.restaurant_active(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurants
                 where id = p_restaurant and subscription_status in ('active', 'trialing'));
$$;

create function public.is_paid(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurant_members m
                 join public.restaurants r on r.id = m.restaurant_id
                 where m.user_id = p_user and r.subscription_status in ('active', 'trialing'));
$$;

-- ----------------------------------------------------------------------------- sign-up gate
-- Runs when someone signs up. Throwing an error cancels the sign-up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s public.app_settings;
  inv public.invites;
  v_code text;
  v_name text;
begin
  select * into s from public.app_settings;
  v_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, ''), '@', 1));
  v_code := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));

  if lower(coalesce(new.email, '')) = lower(s.admin_email) then
    insert into public.profiles (id, display_name, role) values (new.id, v_name, 'admin');
    return new;
  end if;

  if v_code <> '' then
    select * into inv from public.invites where code = v_code for update;
    if not found or inv.uses >= inv.max_uses or (inv.expires_at is not null and inv.expires_at < now()) then
      raise exception 'That invite code is not valid or has already been used.';
    end if;
    if inv.kind = 'restaurant' then
      if (select count(*) from public.restaurant_members where restaurant_id = inv.restaurant_id)
         >= (select seat_limit from public.restaurants where id = inv.restaurant_id) then
        raise exception 'This restaurant has no free seats left.';
      end if;
      insert into public.profiles (id, display_name, role) values (new.id, v_name, 'client');
      insert into public.restaurant_members (restaurant_id, user_id, member_role)
        values (inv.restaurant_id, new.id, inv.member_role);
    else
      insert into public.profiles (id, display_name, role) values (new.id, v_name, 'student');
    end if;
    update public.invites set uses = uses + 1 where code = v_code;
  elsif s.open_signup then
    insert into public.profiles (id, display_name, role) values (new.id, v_name, 'student');
  else
    raise exception 'Sign-up is by invitation only. Ask for an invite code.';
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------- guards
-- People can change their own name, never their role.
create function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then new.role := old.role; new.id := old.id; end if;
  return new;
end $$;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

-- Non-admins can edit a recipe's content but not who owns it, where it lives, or its review state.
create function public.guard_recipe_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.owner_id := old.owner_id;
    new.restaurant_id := old.restaurant_id;
    new.scope := old.scope;
    new.status := old.status;
    new.source_recipe_id := old.source_recipe_id;
    new.author_name := old.author_name;
    new.review_note := old.review_note;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger guard_recipe_update before update on public.recipes
  for each row execute function public.guard_recipe_update();

-- Free accounts can keep a limited number of private recipes (limit lives in app_settings).
create function public.enforce_free_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim int;
begin
  if new.scope = 'private' and not public.is_admin() and not public.is_paid(new.owner_id) then
    select free_recipe_limit into lim from public.app_settings;
    if (select count(*) from public.recipes where owner_id = new.owner_id and scope = 'private') >= lim then
      raise exception 'The free plan allows % private recipes. Upgrade to add more.', lim;
    end if;
  end if;
  return new;
end $$;
create trigger enforce_free_limit before insert on public.recipes
  for each row execute function public.enforce_free_limit();

-- ----------------------------------------------------------------------------- actions the app calls
-- Share a private recipe: makes a pending COPY for the admin to review.
create function public.submit_to_community(p_recipe uuid, p_confirm boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.recipes; new_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if p_confirm is not true then
    raise exception 'Please confirm this is your own recipe or that you have the right to share it.';
  end if;
  select * into r from public.recipes where id = p_recipe and owner_id = auth.uid() and scope = 'private';
  if not found then raise exception 'Recipe not found.'; end if;
  insert into public.recipes (owner_id, scope, status, title, categories, body, source_recipe_id, author_name)
  values (auth.uid(), 'community', 'pending', r.title, r.categories, r.body, r.id,
          coalesce((select nullif(display_name, '') from public.profiles where id = auth.uid()), 'A chef'))
  returning id into new_id;
  return new_id;
exception when unique_violation then
  raise exception 'This recipe has already been shared and is waiting or live in Community.';
end $$;

-- Make an invite code. Admins can make any; a restaurant owner can make one staff invite for their own restaurant.
create function public.create_invite(p_kind text, p_restaurant uuid default null, p_member_role text default 'staff',
                                     p_max_uses int default 1, p_days int default 14) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if public.is_admin() then
    null;
  elsif p_kind = 'restaurant' and public.is_owner(p_restaurant) then
    p_member_role := 'staff';
    p_max_uses := 1;
  else
    raise exception 'You are not allowed to create this invite.';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.invites (code, kind, restaurant_id, member_role, max_uses, expires_at, created_by)
  values (v_code, p_kind, case when p_kind = 'restaurant' then p_restaurant end, p_member_role, p_max_uses,
          now() + make_interval(days => p_days), auth.uid());
  return v_code;
end $$;

-- Remove a staff member (restaurant owner or admin). The last owner cannot be removed.
create function public.remove_member(p_restaurant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_owner(p_restaurant)) then
    raise exception 'You are not allowed to remove members of this restaurant.';
  end if;
  if exists (select 1 from public.restaurant_members
             where restaurant_id = p_restaurant and user_id = p_user and member_role = 'owner')
     and (select count(*) from public.restaurant_members
          where restaurant_id = p_restaurant and member_role = 'owner') <= 1 then
    raise exception 'A restaurant needs at least one owner.';
  end if;
  delete from public.restaurant_members where restaurant_id = p_restaurant and user_id = p_user;
end $$;

-- ----------------------------------------------------------------------------- row-level security
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.invites enable row level security;
alter table public.recipes enable row level security;

create policy settings_admin on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy restaurants_read on public.restaurants for select to authenticated
  using (public.is_admin() or public.is_member(id));
create policy restaurants_admin on public.restaurants for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy members_read on public.restaurant_members for select to authenticated
  using (public.is_admin() or user_id = auth.uid() or public.is_member(restaurant_id));
create policy members_admin on public.restaurant_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy invites_admin on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy recipes_read on public.recipes for select to authenticated using (
  public.is_admin()
  or owner_id = auth.uid()
  or (scope = 'community' and status = 'approved')
  or (scope = 'restaurant' and public.is_member(restaurant_id) and public.restaurant_active(restaurant_id))
);
create policy recipes_insert_own on public.recipes for insert to authenticated
  with check (owner_id = auth.uid() and scope = 'private' and status = 'approved');
create policy recipes_update_own on public.recipes for update to authenticated
  using (owner_id = auth.uid() and scope = 'private')
  with check (owner_id = auth.uid() and scope = 'private' and status = 'approved');
create policy recipes_delete_own on public.recipes for delete to authenticated
  using (owner_id = auth.uid() and scope in ('private', 'community'));
create policy recipes_admin on public.recipes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------- per-person data (stars)
create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stars jsonb not null default '[]'
    check (jsonb_typeof(stars) = 'array' and jsonb_array_length(stars) <= 5000),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_user_data() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch before insert or update on public.user_data
  for each row execute function public.touch_user_data();

alter table public.user_data enable row level security;
drop policy if exists user_data_own on public.user_data;
create policy user_data_own on public.user_data for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.user_data from anon;
-- Newer Supabase projects do not expose new tables automatically, so say it explicitly.
grant select, insert, update, delete on public.user_data to authenticated;
revoke execute on function public.touch_user_data() from public, anon;

-- ----------------------------------------------------------------------------- who may call what
-- Signed-out visitors (the "anon" role) get nothing. Signed-in users get only the actions below.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_admin(), public.is_member(uuid), public.is_owner(uuid),
  public.restaurant_active(uuid), public.is_paid(uuid) to authenticated;
grant execute on function public.submit_to_community(uuid, boolean), public.create_invite(text, uuid, text, int, int),
  public.remove_member(uuid, uuid) to authenticated;
