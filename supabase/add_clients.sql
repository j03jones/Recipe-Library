-- Meal prep clients (v0.22.0): client accounts, weekly menus they approve meal by meal, history,
-- favourites, requests and ratings. Safe to run more than once. Run after everything else.
-- Existing projects: paste this into Supabase > SQL Editor > Run. (New projects get it from schema.sql.)
--
-- Who can see what
--   The chef (the admin account) sees and changes everything here.
--   A client sees only their own client record, their own menus once sent, and the meals on them.
--   A meal row is a snapshot made for the client: dish name, description, ingredient names, nutrition
--   per serving, allergens and reheating notes. It never holds amounts or the method, and the link
--   back to the recipe lives in client_meal_private, which clients cannot read.
--   Clients never write to these tables directly: they answer through the functions at the bottom,
--   which change only the columns a client may change, on their own rows.

-- ------------------------------------------------------------------ tables

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  chef_id uuid not null references auth.users (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,     -- the client's own login, once they join
  name text not null check (length(name) between 1 and 120),
  email text not null default '' check (length(email) <= 200),    -- used to link their login when they sign up
  plan text not null default 'custom' check (plan in ('family', 'couple', 'lean', 'custom')),
  entrees int not null default 5 check (entrees between 1 and 30),          -- dishes per week
  servings int not null default 2 check (servings between 1 and 20),        -- portions of each dish
  weekly_fee numeric(8, 2) not null default 0 check (weekly_fee >= 0),      -- the service fee (groceries are extra)
  allergens text[] not null default '{}',
  allergy_notes text not null default '' check (length(allergy_notes) <= 1000),
  dislikes text not null default '' check (length(dislikes) <= 1000),       -- foods to avoid, diets
  targets jsonb not null default '{}' check (jsonb_typeof(targets) = 'object'),   -- daily {kcal, protein, carbs, fat}
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists clients_user on public.clients (user_id) where user_id is not null;
create unique index if not exists clients_one_per_login on public.clients (chef_id, user_id) where user_id is not null;

-- the chef's own notes about a client (gate code, kitchen quirks): never shown to the client
create table if not exists public.client_notes (
  client_id uuid primary key references public.clients (id) on delete cascade,
  notes text not null default '' check (length(notes) <= 5000)
);

create table if not exists public.client_menus (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  week_start date not null,                                   -- the Monday of the week being cooked for
  status text not null default 'draft' check (status in ('draft', 'sent', 'closed')),
  approve_by timestamptz,                                     -- "please answer by"
  note text not null default '' check (length(note) <= 2000), -- from the chef, shown at the top of the menu
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, week_start)
);

create table if not exists public.client_meals (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.client_menus (id) on delete cascade,
  position int not null default 0,
  title text not null check (length(title) between 1 and 200),
  description text not null default '' check (length(description) <= 1000),
  ingredients text[] not null default '{}',                   -- names only
  allergens text[] not null default '{}',                     -- confirmed by the chef
  nutrition jsonb not null default '{}' check (jsonb_typeof(nutrition) = 'object'),   -- per serving
  servings int not null default 1 check (servings between 1 and 100),
  reheat text not null default '' check (length(reheat) <= 1000),
  storage text not null default '' check (length(storage) <= 500),
  use_by date,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'swap')),
  client_note text not null default '' check (length(client_note) <= 1000),
  responded_at timestamptz,
  rating int check (rating between 1 and 5),
  feedback text not null default '' check (length(feedback) <= 1000),
  rated_at timestamptz
);
create index if not exists client_meals_menu on public.client_meals (menu_id, position);

-- what only the chef needs about a meal: which recipe it is, at what scale, and what it costs
create table if not exists public.client_meal_private (
  meal_id uuid primary key references public.client_meals (id) on delete cascade,
  recipe_id text not null default '',
  factor text not null default '1',
  grocery_cost numeric(8, 2)
);

-- dishes a client marked as favourites, and dishes they asked to have again
create table if not exists public.client_favorites (
  client_id uuid not null references public.clients (id) on delete cascade,
  dish text not null check (length(dish) between 1 and 200),   -- lower-case dish name
  title text not null,
  created_at timestamptz not null default now(),
  primary key (client_id, dish)
);
create table if not exists public.client_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  note text not null default '' check (length(note) <= 1000),
  status text not null default 'open' check (status in ('open', 'planned', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists client_requests_open on public.client_requests (client_id) where status = 'open';

-- a week that worked, saved to reuse for another client
create table if not exists public.client_menu_templates (
  id uuid primary key default gen_random_uuid(),
  chef_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  meals jsonb not null check (jsonb_typeof(meals) = 'array' and pg_column_size(meals) <= 262144),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ who is asking

create or replace function public.is_my_client(p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.clients where id = p_client and user_id = auth.uid());
$$;

-- a menu the signed-in client may see: theirs, and already sent to them
create or replace function public.is_my_menu(p_menu uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.client_menus m join public.clients c on c.id = m.client_id
                 where m.id = p_menu and c.user_id = auth.uid() and m.status in ('sent', 'closed'));
$$;

-- ------------------------------------------------------------------ access rules

alter table public.clients enable row level security;
alter table public.client_notes enable row level security;
alter table public.client_menus enable row level security;
alter table public.client_meals enable row level security;
alter table public.client_meal_private enable row level security;
alter table public.client_favorites enable row level security;
alter table public.client_requests enable row level security;
alter table public.client_menu_templates enable row level security;

drop policy if exists clients_chef on public.clients;
create policy clients_chef on public.clients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists clients_own_read on public.clients;
create policy clients_own_read on public.clients for select to authenticated using (user_id = auth.uid());

drop policy if exists client_notes_chef on public.client_notes;
create policy client_notes_chef on public.client_notes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists client_menus_chef on public.client_menus;
create policy client_menus_chef on public.client_menus for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists client_menus_own_read on public.client_menus;
create policy client_menus_own_read on public.client_menus for select to authenticated
  using (status in ('sent', 'closed') and public.is_my_client(client_id));

drop policy if exists client_meals_chef on public.client_meals;
create policy client_meals_chef on public.client_meals for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists client_meals_own_read on public.client_meals;
create policy client_meals_own_read on public.client_meals for select to authenticated
  using (public.is_my_menu(menu_id));

drop policy if exists client_meal_private_chef on public.client_meal_private;
create policy client_meal_private_chef on public.client_meal_private for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists client_favorites_chef on public.client_favorites;
create policy client_favorites_chef on public.client_favorites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists client_favorites_own_read on public.client_favorites;
create policy client_favorites_own_read on public.client_favorites for select to authenticated
  using (public.is_my_client(client_id));

drop policy if exists client_requests_chef on public.client_requests;
create policy client_requests_chef on public.client_requests for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists client_requests_own_read on public.client_requests;
create policy client_requests_own_read on public.client_requests for select to authenticated
  using (public.is_my_client(client_id));

drop policy if exists client_menu_templates_chef on public.client_menu_templates;
create policy client_menu_templates_chef on public.client_menu_templates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.clients, public.client_notes, public.client_menus, public.client_meals,
  public.client_meal_private, public.client_favorites, public.client_requests,
  public.client_menu_templates from anon;
grant select, insert, update, delete on public.clients, public.client_notes, public.client_menus,
  public.client_meals, public.client_meal_private, public.client_favorites, public.client_requests,
  public.client_menu_templates to authenticated;

-- ------------------------------------------------------------------ what a client may do

-- Link this login to the client record the chef made for the same email address (once the address
-- is confirmed). Returns how many records were linked; calling it again does nothing.
create or replace function public.claim_client() returns int
language plpgsql security definer set search_path = public, auth as $$
declare v_email text; v_ok boolean; n int;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  select lower(u.email), u.email_confirmed_at is not null into v_email, v_ok from auth.users u where u.id = auth.uid();
  if not coalesce(v_ok, false) or coalesce(v_email, '') = '' then return 0; end if;
  update public.clients set user_id = auth.uid()
    where user_id is null and email <> '' and lower(email) = v_email;
  get diagnostics n = row_count;
  return n;
end $$;

-- Approve a proposed meal, or ask for it to be swapped (with a note). Only on a menu that has been
-- sent and is not closed.
create or replace function public.respond_to_meal(p_meal uuid, p_approve boolean, p_note text default '')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  update public.client_meals m
     set status = case when p_approve then 'approved' else 'swap' end,
         client_note = left(trim(coalesce(p_note, '')), 1000),
         responded_at = now()
   where m.id = p_meal
     and exists (select 1 from public.client_menus mm join public.clients c on c.id = mm.client_id
                 where mm.id = m.menu_id and c.user_id = auth.uid() and mm.status = 'sent');
  if not found then raise exception 'This menu is not open for answers.'; end if;
end $$;

-- Rate a meal you have had (1 to 5) and say something about it.
create or replace function public.rate_meal(p_meal uuid, p_rating int, p_feedback text default '')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if p_rating is not null and p_rating not between 1 and 5 then raise exception 'Choose 1 to 5 stars.'; end if;
  update public.client_meals m
     set rating = p_rating, feedback = left(trim(coalesce(p_feedback, '')), 1000), rated_at = now()
   where m.id = p_meal and public.is_my_menu(m.menu_id);
  if not found then raise exception 'Meal not found.'; end if;
end $$;

-- Mark a dish as a favourite, or take the mark off.
create or replace function public.set_favorite(p_client uuid, p_title text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_title text := left(trim(coalesce(p_title, '')), 200);
begin
  if not public.is_my_client(p_client) then raise exception 'Not your account.'; end if;
  if v_title = '' then raise exception 'Which dish?'; end if;
  if p_on then
    insert into public.client_favorites (client_id, dish, title) values (p_client, lower(v_title), v_title)
    on conflict (client_id, dish) do nothing;
  else
    delete from public.client_favorites where client_id = p_client and dish = lower(v_title);
  end if;
end $$;

-- Ask to have a dish (again). At most 20 open requests per client.
create or replace function public.request_meal(p_client uuid, p_title text, p_note text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_title text := left(trim(coalesce(p_title, '')), 200); v_id uuid;
begin
  if not public.is_my_client(p_client) then raise exception 'Not your account.'; end if;
  if v_title = '' then raise exception 'Which dish would you like?'; end if;
  if (select count(*) from public.client_requests where client_id = p_client and status = 'open') >= 20 then
    raise exception 'You already have 20 requests waiting. Your chef will get to them.';
  end if;
  insert into public.client_requests (client_id, title, note)
  values (p_client, v_title, left(trim(coalesce(p_note, '')), 1000)) returning id into v_id;
  return v_id;
end $$;

-- Keep your own allergies and foods to avoid up to date. The list of allergens is fixed (the same
-- nine as the intake form on jonesridgekitchen.com).
create or replace function public.update_my_preferences(p_client uuid, p_allergens text[], p_allergy_notes text, p_dislikes text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_known text[] := array['Peanuts', 'Tree nuts', 'Milk / dairy', 'Eggs', 'Wheat / gluten', 'Soy', 'Fish', 'Shellfish', 'Sesame'];
begin
  if not public.is_my_client(p_client) then raise exception 'Not your account.'; end if;
  update public.clients
     set allergens = coalesce((select array_agg(a order by array_position(v_known, a))
                               from unnest(coalesce(p_allergens, '{}')) a where a = any (v_known)), '{}'),
         allergy_notes = left(trim(coalesce(p_allergy_notes, '')), 1000),
         dislikes = left(trim(coalesce(p_dislikes, '')), 1000)
   where id = p_client;
end $$;

revoke execute on function public.is_my_client(uuid), public.is_my_menu(uuid), public.claim_client(),
  public.respond_to_meal(uuid, boolean, text), public.rate_meal(uuid, int, text),
  public.set_favorite(uuid, text, boolean), public.request_meal(uuid, text, text),
  public.update_my_preferences(uuid, text[], text, text) from public, anon;
grant execute on function public.is_my_client(uuid), public.is_my_menu(uuid), public.claim_client(),
  public.respond_to_meal(uuid, boolean, text), public.rate_meal(uuid, int, text),
  public.set_favorite(uuid, text, boolean), public.request_meal(uuid, text, text),
  public.update_my_preferences(uuid, text[], text, text) to authenticated;
