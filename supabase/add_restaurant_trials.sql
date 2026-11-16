-- Restaurant trials that end on their own (v0.27.0). Safe to run more than once.
--
-- A restaurant on 'trialing' now has an end date. Its collection is shown, and its staff count as on a
-- paid plan, while the plan is 'active', or 'trialing' with no end date or an end date still to come.
-- When the trial ends nothing is deleted: the collection is hidden again until the admin extends the
-- trial or marks the restaurant Active.

alter table public.restaurants add column if not exists trial_ends_at timestamptz;

create or replace function public.restaurant_active(p_restaurant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurants
                 where id = p_restaurant
                   and (subscription_status = 'active'
                        or (subscription_status = 'trialing' and (trial_ends_at is null or trial_ends_at > now()))));
$$;

create or replace function public.is_paid(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.restaurant_members m
                 join public.restaurants r on r.id = m.restaurant_id
                 where m.user_id = p_user
                   and (r.subscription_status = 'active'
                        or (r.subscription_status = 'trialing' and (r.trial_ends_at is null or r.trial_ends_at > now()))));
$$;

notify pgrst, 'reload schema';
