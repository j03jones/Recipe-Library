-- Par list and daily prep (add_par_list.sql). Run after test.sql (it uses t.* and open sign-up).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
delete from t.r;
update public.app_settings set open_signup = true;
insert into public.restaurants(name, subscription_status) values ('Par Place', 'active'), ('Other Diner', 'active');
select id as pr from public.restaurants where name='Par Place' \gset
select id as po from public.restaurants where name='Other Diner' \gset
insert into auth.users(email) values ('parowner@x.test'), ('parcook@x.test'), ('paroutsider@x.test');
select id as pown from auth.users where email='parowner@x.test' \gset
select id as pcook from auth.users where email='parcook@x.test' \gset
select id as pout from auth.users where email='paroutsider@x.test' \gset
select id as padmin from auth.users where email='admin@x.test' \gset
update public.profiles set display_name = 'Casey' where id = :'pcook';
insert into public.restaurant_members(restaurant_id, user_id, member_role) values (:'pr', :'pown', 'owner'), (:'pr', :'pcook', 'staff'), (:'po', :'pout', 'owner');
insert into public.recipes(owner_id, restaurant_id, scope, title, body, status) values (:'padmin', :'pr', 'restaurant', 'Pico de gallo', '{}', 'approved');
insert into public.recipes(owner_id, restaurant_id, scope, title, body, status) values (:'padmin', :'po', 'restaurant', 'Their salsa', '{}', 'approved');
select id as pico from public.recipes where title='Pico de gallo' \gset
select id as theirs from public.recipes where title='Their salsa' \gset

-- owners set the items and pars
select t.login(:'pown'); set role authenticated;
insert into public.restaurant_par_items(restaurant_id, recipe_id, name, unit, per_batch, station, pars)
  values (:'pr', :'pico', 'Pico', 'qt', 4, 'Line', '{2,4,4,4,4,8,8}');
insert into public.restaurant_par_items(restaurant_id, name, unit, pars) values (:'pr', 'Lemons, cut', 'each', '{10,10,10,10,10,20,20}');
select t.expect('an owner adds par items', t.n($$ select count(*) from public.restaurant_par_items $$) = 2);
select t.denied('a par item cannot use another restaurant''s recipe',
  format($$ insert into public.restaurant_par_items(restaurant_id, recipe_id, name) values (%L, %L, 'Sneaky') $$, :'pr', :'theirs'));
select t.denied('pars need all seven days', format($$ insert into public.restaurant_par_items(restaurant_id, name, pars) values (%L, 'Bad', '{1,2}') $$, :'pr'));
select t.denied('pars cannot be negative', format($$ insert into public.restaurant_par_items(restaurant_id, name, pars) values (%L, 'Bad', '{1,1,1,1,1,1,-1}') $$, :'pr'));
select t.denied('an owner cannot add items for another restaurant', format($$ insert into public.restaurant_par_items(restaurant_id, name) values (%L, 'Sneaky') $$, :'po'));
reset role;
select id as pitem from public.restaurant_par_items where name='Pico' \gset
select id as litem from public.restaurant_par_items where name='Lemons, cut' \gset

-- staff count and make, but don't set pars
select t.login(:'pcook'); set role authenticated;
select t.expect('staff see the par items', t.n($$ select count(*) from public.restaurant_par_items $$) = 2);
update public.restaurant_par_items set pars = '{99,99,99,99,99,99,99}';
select t.expect('staff cannot change pars', t.n($$ select count(*) from public.restaurant_par_items where 99 = any(pars) $$) = 0);
select t.denied('staff cannot add par items', format($$ insert into public.restaurant_par_items(restaurant_id, name) values (%L, 'Mine') $$, :'pr'));
select t.denied('staff cannot write the prep days directly',
  format($$ insert into public.restaurant_prep_days(item_id, for_date, restaurant_id) values (%L, current_date, %L) $$, :'pitem', :'pr'));
select public.save_par_count(:'pr', current_date + 1, jsonb_build_array(
  jsonb_build_object('item', :'pitem', 'on_hand', 1.5), jsonb_build_object('item', :'litem', 'on_hand', null),
  jsonb_build_object('item', gen_random_uuid(), 'on_hand', 3)));
select t.expect('the count at close is kept for tomorrow, with that weekday''s par',
  (select par = ('{2,4,4,4,4,8,8}'::numeric[])[extract(dow from current_date + 1)::int + 1] and on_hand = 1.5 and counted_name = 'Casey'
   from public.restaurant_prep_days where item_id = :'pitem' and for_date = current_date + 1));
select t.expect('an item left blank is kept as not counted',
  (select on_hand is null from public.restaurant_prep_days where item_id = :'litem' and for_date = current_date + 1));
select t.denied('counts are only for today or tomorrow', format($$ select public.save_par_count(%L, current_date + 30, '[]') $$, :'pr'));
select t.denied('a negative count is refused', format($$ select public.save_par_count(%L, current_date, jsonb_build_array(jsonb_build_object('item', %L, 'on_hand', -1))) $$, :'pr', :'pitem'));
select public.record_prep(:'pitem', current_date + 1, 2);
select public.record_prep(:'pitem', current_date + 1, 0.5);
select t.expect('what is made adds up, and each time is logged',
  (select made = 2.5 and jsonb_array_length(made_log) = 2 and made_log->0->>'by' = 'Casey'
   from public.restaurant_prep_days where item_id = :'pitem' and for_date = current_date + 1));
select public.record_prep(:'pitem', current_date + 1, -10);
select t.expect('taking back more than was made stops at zero',
  (select made = 0 from public.restaurant_prep_days where item_id = :'pitem' and for_date = current_date + 1));
select public.record_prep(:'litem', current_date, 5);
select t.expect('making an item that was not counted starts the day',
  (select made = 5 and on_hand is null from public.restaurant_prep_days where item_id = :'litem' and for_date = current_date));
select public.save_par_count(:'pr', current_date + 1, jsonb_build_array(jsonb_build_object('item', :'pitem', 'on_hand', 3)));
select t.expect('counting again replaces the count and keeps what was made',
  (select on_hand = 3 and jsonb_array_length(made_log) = 3 from public.restaurant_prep_days where item_id = :'pitem' and for_date = current_date + 1));
reset role;

-- outsiders, and a lapsed plan
select t.login(:'pout'); set role authenticated;
select t.expect('another restaurant sees none of the par list',
  t.n($$ select count(*) from public.restaurant_par_items $$) = 0 and t.n($$ select count(*) from public.restaurant_prep_days $$) = 0);
select t.denied('another restaurant cannot count here', format($$ select public.save_par_count(%L, current_date, '[]') $$, :'pr'));
select t.denied('another restaurant cannot mark prep here', format($$ select public.record_prep(%L, current_date, 1) $$, :'pitem'));
reset role;
update public.restaurants set subscription_status = 'canceled' where id = :'pr';
select t.login(:'pcook'); set role authenticated;
select t.denied('no counting once the plan has lapsed', format($$ select public.save_par_count(%L, current_date, '[]') $$, :'pr'));
select t.denied('no prep marked once the plan has lapsed', format($$ select public.record_prep(%L, current_date, 1) $$, :'pitem'));
reset role;
select t.login(:'pown'); set role authenticated;
update public.restaurant_par_items set name = 'Changed';
select t.expect('owners cannot change pars once the plan has lapsed', t.n($$ select count(*) from public.restaurant_par_items where name = 'Changed' $$) = 0);
reset role;
select t.login(:'padmin'); set role authenticated;
select t.expect('the admin sees every restaurant''s prep', t.n(format($$ select count(*) from public.restaurant_prep_days where restaurant_id = %L $$, :'pr')) = 3);
select public.record_prep(:'pitem', current_date, 1);
select t.expect('the admin can mark prep even on a lapsed plan', t.n(format($$ select count(*) from public.restaurant_prep_days where item_id = %L and for_date = current_date $$, :'pitem')) = 1);
reset role;
select t.denied('anonymous visitors cannot read the prep', $$ set role anon; select count(*) from public.restaurant_prep_days $$);
reset role;
delete from public.recipes where id = :'pico';
select t.expect('deleting a recipe keeps its par item, unlinked', (select recipe_id is null from public.restaurant_par_items where id = :'pitem'));

\o
\echo
select case when ok then 'PASS' else 'FAIL' end as result, name, case when ok then '' else detail end as detail from t.r order by n;
select count(*) filter (where ok) || ' of ' || count(*) || ' checks passed' as summary from t.r;
