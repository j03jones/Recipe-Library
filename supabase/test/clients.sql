-- Access-rule checks for supabase/add_clients.sql. Plain SQL: run it after the schema, as a superuser.
-- Every check raises an exception on failure, so reaching the end means they all passed.
do $test$
declare
  chef uuid := gen_random_uuid(); anna uuid := gen_random_uuid(); ben uuid := gen_random_uuid();
  eve uuid := gen_random_uuid(); carl uuid := gen_random_uuid();
  ca uuid; cb uuid; cc uuid; ma uuid; mb uuid; meal1 uuid; meal2 uuid; mealb uuid; n int; t text;
  procedure_ok boolean;
begin
  -- people (triggers off: these are test rows, not sign-ups)
  set local session_replication_role = replica;
  insert into auth.users (id, email, email_confirmed_at) values
    (chef, 'chef-t@x.test', now()), (anna, 'Anna-T@x.test', now()), (ben, 'ben-t@x.test', now()),
    (eve, 'eve-t@x.test', now()), (carl, 'carl-t@x.test', null);
  insert into public.profiles (id, display_name, role) values
    (chef, 'Chef', 'admin'), (anna, 'Anna', 'student'), (ben, 'Ben', 'student'), (eve, 'Eve', 'student'), (carl, 'Carl', 'student');
  set local session_replication_role = origin;

  -- ---- the chef sets things up
  perform set_config('request.jwt.claim.sub', chef::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', chef, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.clients (chef_id, name, email, plan, entrees, servings, weekly_fee)
    values (chef, 'Anna', 'anna-t@x.test', 'couple', 5, 2, 185) returning id into ca;
  insert into public.clients (chef_id, name, email, plan) values (chef, 'Ben', 'ben-t@x.test', 'lean') returning id into cb;
  insert into public.clients (chef_id, name, email) values (chef, 'Carl', 'carl-t@x.test') returning id into cc;
  insert into public.client_notes (client_id, notes) values (ca, 'Gate code 1234');
  insert into public.client_menus (client_id, week_start) values (ca, '2026-11-16') returning id into ma;
  insert into public.client_menus (client_id, week_start, status, sent_at) values (cb, '2026-11-16', 'sent', now()) returning id into mb;
  insert into public.client_meals (menu_id, position, title, ingredients, allergens, nutrition, servings)
    values (ma, 0, 'Chicken gumbo', array['Chicken', 'Andouille', 'Rice'], array['Wheat / gluten'], '{"kcal": 520}', 2) returning id into meal1;
  insert into public.client_meals (menu_id, position, title) values (ma, 1, 'Catfish tacos') returning id into meal2;
  insert into public.client_meals (menu_id, position, title) values (mb, 0, 'Turkey chili') returning id into mealb;
  insert into public.client_meal_private (meal_id, recipe_id, factor, grocery_cost) values (meal1, 'abc123', '2', 14.50);
  reset role;

  -- ---- Anna signs in
  perform set_config('request.jwt.claim.sub', anna::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', anna, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'FAIL: before claiming, a login sees % client records', n; end if;
  if public.claim_client() <> 1 then raise exception 'FAIL: claim by confirmed email (any capitals) should link 1 record'; end if;
  if public.claim_client() <> 0 then raise exception 'FAIL: claiming twice should do nothing'; end if;
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FAIL: a client should see exactly their own record, saw %', n; end if;
  select count(*) into n from public.client_notes;
  if n <> 0 then raise exception 'FAIL: a client can read the chef''s notes'; end if;
  select count(*) into n from public.client_menus;
  if n <> 0 then raise exception 'FAIL: a client can see a draft menu (or someone else''s)'; end if;
  select count(*) into n from public.client_meals;
  if n <> 0 then raise exception 'FAIL: a client can see meals on a draft menu'; end if;
  begin
    perform public.respond_to_meal(meal1, true, '');
    raise exception 'FAIL: answered a meal on a menu that was not sent';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- ---- the chef sends Anna's menu
  perform set_config('request.jwt.claim.sub', chef::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', chef, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.client_menus set status = 'sent', sent_at = now(), approve_by = now() + interval '3 days' where id = ma;
  reset role;

  -- ---- Anna looks and answers
  perform set_config('request.jwt.claim.sub', anna::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', anna, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.client_menus;
  if n <> 1 then raise exception 'FAIL: a client should see their sent menu and only it, saw %', n; end if;
  select count(*) into n from public.client_meals;
  if n <> 2 then raise exception 'FAIL: a client should see the 2 meals on their menu, saw %', n; end if;
  select count(*) into n from public.client_meal_private;
  if n <> 0 then raise exception 'FAIL: a client can read which recipe a meal is and what it costs'; end if;
  select count(*) into n from public.client_menu_templates;
  if n <> 0 then raise exception 'FAIL: a client can read menu templates'; end if;
  update public.client_meals set title = 'Hacked', status = 'approved' where id = meal1;
  select title into t from public.client_meals where id = meal1;
  if t <> 'Chicken gumbo' then raise exception 'FAIL: a client changed a meal directly'; end if;
  update public.clients set weekly_fee = 1, allergens = '{}' where id = ca;
  if (select weekly_fee from public.clients where id = ca) <> 185 then raise exception 'FAIL: a client changed their own fee'; end if;
  begin
    insert into public.clients (chef_id, name) values (anna, 'Sneaky');
    raise exception 'FAIL: a client created a client record';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    insert into public.client_meals (menu_id, title) values (ma, 'Lobster');
    raise exception 'FAIL: a client added a meal to their menu';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.respond_to_meal(meal1, true, '');
  perform public.respond_to_meal(meal2, false, '  No fish this week please  ');
  if (select status from public.client_meals where id = meal1) <> 'approved' then raise exception 'FAIL: approve did not stick'; end if;
  select status || '|' || client_note into t from public.client_meals where id = meal2;
  if t <> 'swap|No fish this week please' then raise exception 'FAIL: swap request stored as %', t; end if;
  begin
    perform public.respond_to_meal(mealb, true, '');
    raise exception 'FAIL: a client answered another client''s meal';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.rate_meal(meal1, 5, 'Loved it');
  if (select rating from public.client_meals where id = meal1) <> 5 then raise exception 'FAIL: rating did not stick'; end if;
  begin
    perform public.rate_meal(meal1, 9, '');
    raise exception 'FAIL: a rating of 9 was accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.rate_meal(mealb, 1, 'not mine');
    raise exception 'FAIL: a client rated another client''s meal';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.set_favorite(ca, 'Chicken Gumbo', true);
  perform public.set_favorite(ca, 'chicken gumbo', true);       -- same dish, counted once
  select count(*) into n from public.client_favorites;
  if n <> 1 then raise exception 'FAIL: expected 1 favourite, saw %', n; end if;
  perform public.set_favorite(ca, 'CHICKEN GUMBO', false);
  select count(*) into n from public.client_favorites;
  if n <> 0 then raise exception 'FAIL: favourite was not removed'; end if;
  perform public.request_meal(ca, 'Chicken gumbo', 'for the 23rd');
  select count(*) into n from public.client_requests;
  if n <> 1 then raise exception 'FAIL: expected 1 request, saw %', n; end if;
  begin
    perform public.request_meal(cb, 'Free food', '');
    raise exception 'FAIL: a client made a request on another client''s account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.set_favorite(cb, 'Turkey chili', true);
    raise exception 'FAIL: a client set a favourite on another client''s account';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;

  perform public.update_my_preferences(ca, array['Sesame', 'Peanuts', 'Gold', 'peanuts'], ' EpiPen ', 'No cilantro');
  select array_to_string(allergens, ',') || '|' || allergy_notes || '|' || dislikes into t from public.clients where id = ca;
  if t <> 'Peanuts,Sesame|EpiPen|No cilantro' then raise exception 'FAIL: preferences stored as %', t; end if;
  begin
    perform public.update_my_preferences(cb, array['Fish'], '', '');
    raise exception 'FAIL: a client changed another client''s allergies';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- ---- other people
  perform set_config('request.jwt.claim.sub', eve::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', eve, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.claim_client() <> 0 then raise exception 'FAIL: someone with no client record claimed one'; end if;
  select (select count(*) from public.clients) + (select count(*) from public.client_menus) + (select count(*) from public.client_meals)
       + (select count(*) from public.client_requests) + (select count(*) from public.client_favorites) into n;
  if n <> 0 then raise exception 'FAIL: an unrelated login can see % client rows', n; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', carl::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', carl, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.claim_client() <> 0 then raise exception 'FAIL: an unconfirmed email address claimed a client record'; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    select count(*) into n from public.clients;
    raise exception 'FAIL: a signed-out visitor can read clients';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin
    perform public.claim_client();
    raise exception 'FAIL: a signed-out visitor can call claim_client';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  reset role;

  -- ---- a closed menu takes no more answers, but can still be rated; the chef sees everything
  perform set_config('request.jwt.claim.sub', chef::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', chef, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.client_menus set status = 'closed' where id = ma;
  select count(*) into n from public.client_meals;
  if n <> 3 then raise exception 'FAIL: the chef should see all 3 meals, saw %', n; end if;
  select count(*) into n from public.client_requests where status = 'open';
  if n <> 1 then raise exception 'FAIL: the chef should see the open request'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', anna::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', anna, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.respond_to_meal(meal2, true, '');
    raise exception 'FAIL: answered a meal on a closed menu';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  perform public.rate_meal(meal2, 3, '');
  select count(*) into n from public.client_meals;
  if n <> 2 then raise exception 'FAIL: history (a closed menu) should still be readable'; end if;
  reset role;

  raise notice 'clients: all access checks passed';
end $test$;
