-- Security fixes from the 2026-11-21 app review (v0.42.1). Safe to run again. Run after add_households.sql
-- and add_client_signup.sql.
--
-- 1. The admin email only makes the FIRST admin. Before, any new account with that email became admin, so
--    changing admin_email to an address with no account yet would let whoever signed up with it first take admin.
-- 2. New household join codes are 10 characters instead of 6 (about 290 billion instead of 7.5 million), so
--    they can't be guessed by trying codes one after another. Existing codes keep working.

create or replace function public.handle_new_user() returns trigger
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

  -- The admin email makes the first admin only. Once there is an admin, that email signs up like anyone else,
  -- so changing admin_email later can't hand admin to whoever registers the new address first.
  if lower(coalesce(new.email, '')) = lower(s.admin_email)
     and not exists (select 1 from public.profiles where role = 'admin') then
    insert into public.profiles (id, display_name, role) values (new.id, v_name, 'admin');
    return new;
  end if;

  if v_code <> '' then
    select * into inv from public.invites where code = v_code for update;
    if not found or inv.cancelled_at is not null or inv.uses >= inv.max_uses
       or (inv.expires_at is not null and inv.expires_at < now()) then
      raise exception 'That invite code is not valid or has already been used.';
    end if;
    if inv.kind = 'restaurant' then
      if (select count(*) from public.restaurant_members where restaurant_id = inv.restaurant_id)
         >= (select seat_limit from public.restaurants where id = inv.restaurant_id) then
        raise exception 'This restaurant has no free seats left.';
      end if;
      insert into public.profiles (id, display_name, role, invite_code) values (new.id, v_name, 'client', v_code);
      insert into public.restaurant_members (restaurant_id, user_id, member_role)
        values (inv.restaurant_id, new.id, inv.member_role);
    else
      insert into public.profiles (id, display_name, role, invite_code) values (new.id, v_name, 'student', v_code);
    end if;
    update public.invites set uses = uses + 1 where code = v_code;
  elsif coalesce(new.email, '') <> '' and exists (
      select 1 from public.clients c where c.user_id is null and c.email <> '' and lower(c.email) = lower(new.email)) then
    -- a meal prep client the chef has on file
    insert into public.profiles (id, display_name, role) values (new.id, v_name, 'student');
  elsif s.open_signup then
    insert into public.profiles (id, display_name, role) values (new.id, v_name, 'student');
  else
    raise exception 'Sign-up is by invitation only. Ask for an invite code.';
  end if;
  return new;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.create_household(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if public.my_household() is not null then raise exception 'You are already in a household. Leave it first.'; end if;
  loop
    v_code := upper(substr(translate(replace(gen_random_uuid()::text, '-', ''), '01', ''), 1, 10));   -- no 0/1 to misread
    exit when char_length(v_code) = 10 and not exists (select 1 from public.households where code = v_code);
  end loop;
  insert into public.households (name, code, created_by) values (left(trim(coalesce(p_name, '')), 60), v_code, auth.uid())
    returning id into v_id;
  insert into public.household_members (user_id, household_id) values (auth.uid(), v_id);
  return v_code;
end $$;
