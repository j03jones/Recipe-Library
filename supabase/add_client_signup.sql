-- Meal prep clients set up their own login on jonesridgekitchen.com/my-meals/ (v0.23.0).
-- Safe to run more than once. Run after add_clients.sql.
--
-- Sign-up stays invite-only, with one more way in: an email address the chef has put on a client
-- record that no login is linked to yet. That person can create their account without a code; their
-- login is linked to the client record (claim_client) once they confirm the address. Anyone else
-- still needs an invite code (or open sign-up).

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

  if lower(coalesce(new.email, '')) = lower(s.admin_email) then
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
