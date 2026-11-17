\set ON_ERROR_STOP on
\set QUIET on
create schema t;
create table t.r (n serial, name text, ok boolean, detail text);
create table t.ids (name text primary key, id uuid);
grant usage on schema t to anon, authenticated;
grant all on t.r, t.ids to anon, authenticated;
grant usage on all sequences in schema t to anon, authenticated;
create function t.login(p uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', p::text, false) $$;
create function t.expect(p_name text, p_ok boolean, p_detail text default '') returns void language sql as
  $$ insert into t.r(name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail) $$;
create function t.denied(p_name text, p_stmt text) returns void language plpgsql as $$
begin
  execute p_stmt;
  insert into t.r(name, ok, detail) values (p_name, false, 'was allowed');
exception when others then
  insert into t.r(name, ok, detail) values (p_name, true, sqlerrm);
end $$;
create function t.n(p_stmt text) returns bigint language plpgsql as $$
declare v bigint; begin execute p_stmt into v; return v; end $$;
grant execute on all functions in schema t to anon, authenticated;

\o /dev/null
-- ---- sign-up gate -------------------------------------------------------------
insert into auth.users(email) values ('admin@x.test');
select t.expect('admin email becomes admin', (select role from public.profiles where id = (select id from auth.users where email='admin@x.test')) = 'admin');
select id as admin_id from auth.users where email = 'admin@x.test' \gset
select t.denied('signup without a code is refused', $$ insert into auth.users(email) values ('rando@x.test') $$);
select t.denied('signup with a made-up code is refused', $$ insert into auth.users(email, raw_user_meta_data) values ('rando@x.test', '{"invite_code":"NOPE12345678"}') $$);
select t.expect('refused signups leave no account', t.n($$ select count(*) from auth.users where email='rando@x.test' $$) = 0);

-- ---- admin makes invites ------------------------------------------------------
select t.login(:'admin_id');
set role authenticated;
select public.create_invite('student', null, 'staff', 2, 14) as stu_code \gset
insert into public.restaurants(name, subscription_status, seat_limit) values ('Alpha Grill', 'inactive', 2);
insert into public.restaurants(name, subscription_status, seat_limit) values ('Beta Bistro', 'active', 3);
select id as r1 from public.restaurants where name='Alpha Grill' \gset
select id as r2 from public.restaurants where name='Beta Bistro' \gset
select public.create_invite('restaurant', :'r1', 'owner', 1, 14) as own1_code \gset
select public.create_invite('restaurant', :'r2', 'owner', 1, 14) as own2_code \gset
reset role;

insert into auth.users(email, raw_user_meta_data) values ('s1@x.test', jsonb_build_object('invite_code', :'stu_code', 'display_name', 'Sam'));
insert into auth.users(email, raw_user_meta_data) values ('s2@x.test', jsonb_build_object('invite_code', lower(:'stu_code')));
select t.denied('invite code stops after max uses', format($$ insert into auth.users(email, raw_user_meta_data) values ('s3@x.test', jsonb_build_object('invite_code', %L)) $$, :'stu_code'));
insert into auth.users(email, raw_user_meta_data) values ('c1@x.test', jsonb_build_object('invite_code', :'own1_code'));
insert into auth.users(email, raw_user_meta_data) values ('c2@x.test', jsonb_build_object('invite_code', :'own2_code'));
select t.expect('student profile created', (select role from public.profiles where id=(select id from auth.users where email='s1@x.test')) = 'student');
select t.expect('restaurant invite makes a client owner',
  (select p.role||'/'||m.member_role from public.profiles p join public.restaurant_members m on m.user_id=p.id where p.id=(select id from auth.users where email='c1@x.test')) = 'client/owner');
select id as s1 from auth.users where email='s1@x.test' \gset
select id as s2 from auth.users where email='s2@x.test' \gset
select id as c1 from auth.users where email='c1@x.test' \gset
select id as c2 from auth.users where email='c2@x.test' \gset

-- ---- restaurant collections ---------------------------------------------------
select t.login(:'admin_id'); set role authenticated;
insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (:'admin_id', :'r1', 'restaurant', 'Alpha House Gumbo', '{}');
insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (:'admin_id', :'r2', 'restaurant', 'Beta Brisket', '{}');
select t.expect('admin sees everything', t.n($$ select count(*) from public.recipes $$) = 2);
reset role;

select t.login(:'c1'); set role authenticated;
select t.expect('inactive restaurant cannot see its collection', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 0);
reset role;
update public.restaurants set subscription_status='active' where id=:'r1';
select t.login(:'c1'); set role authenticated;
select t.expect('active restaurant sees only its own collection', t.n($$ select count(*) from public.recipes where title='Alpha House Gumbo' $$) = 1 and t.n($$ select count(*) from public.recipes where title='Beta Brisket' $$) = 0);
select t.denied('client cannot add to another restaurant''s collection', format($$ insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (%L, %L, 'restaurant', 'Sneaky', '{}') $$, :'c1', :'r2'));
reset role;
select t.login(:'s1'); set role authenticated;
select t.expect('students cannot see restaurant collections', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 0);
reset role;
update public.restaurants set subscription_status='canceled' where id=:'r1';
select t.login(:'c1'); set role authenticated;
select t.expect('lapsed subscription hides the collection again', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 0);
reset role;
-- trials (add_restaurant_trials.sql): shown until the end date, then hidden again, nothing deleted
update public.restaurants set subscription_status='trialing', trial_ends_at = now() + interval '14 days' where id=:'r1';
select t.login(:'c1'); set role authenticated;
select t.expect('a restaurant on a trial sees its collection', t.n($$ select count(*) from public.recipes where title='Alpha House Gumbo' $$) = 1);
select t.expect('and its staff count as paid during the trial', public.is_paid(auth.uid()));
reset role;
update public.restaurants set trial_ends_at = now() - interval '1 minute' where id=:'r1';
select t.login(:'c1'); set role authenticated;
select t.expect('an ended trial hides the collection', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 0);
select t.expect('and its staff are back on the free plan', not public.is_paid(auth.uid()));
reset role;
select t.expect('an ended trial deletes nothing', t.n($$ select count(*) from public.recipes where title='Alpha House Gumbo' $$) = 1);
update public.restaurants set subscription_status='canceled', trial_ends_at = null where id=:'r1';

-- ---- private recipes and the free limit ---------------------------------------
update public.app_settings set free_recipe_limit = 2;
select t.login(:'s1'); set role authenticated;
insert into public.recipes(owner_id, scope, title, body) values (:'s1', 'private', 'Sam Soup 1', '{}');
insert into public.recipes(owner_id, scope, title, body) values (:'s1', 'private', 'Sam Soup 2', '{}');
select t.denied('free plan limit blocks a third private recipe', format($$ insert into public.recipes(owner_id, scope, title, body) values (%L, 'private', 'Sam Soup 3', '{}') $$, :'s1'));
select t.denied('cannot create recipes as someone else', format($$ insert into public.recipes(owner_id, scope, title, body) values (%L, 'private', 'Forged', '{}') $$, :'s2'));
select t.denied('cannot insert straight into Community', format($$ insert into public.recipes(owner_id, scope, status, title, body) values (%L, 'community', 'approved', 'Self approved', '{}') $$, :'s1'));
reset role;
select t.login(:'s2'); set role authenticated;
select t.expect('other students cannot see private recipes', t.n($$ select count(*) from public.recipes where title like 'Sam Soup%' $$) = 0);
update public.recipes set title='hacked' where title like 'Sam Soup%';
select t.expect('other students cannot edit private recipes', t.n($$ select count(*) from public.recipes where title='hacked' $$) = 0);
reset role;
update public.restaurants set subscription_status='active' where id=:'r1';
select t.login(:'c1'); set role authenticated;
insert into public.recipes(owner_id, scope, title, body) select :'c1', 'private', 'Client ' || g, '{}' from generate_series(1, 5) g;
select t.expect('paying clients are not held to the free limit', t.n($$ select count(*) from public.recipes where owner_id = auth.uid() and scope='private' $$) = 5);
insert into public.recipes(owner_id, scope, title, body) values (:'c1', 'private', 'Imported dish', '{"src": {"author": "Someone Else", "name": "A Blog", "url": "https://example.com/dish/"}}');
select id as imported1 from public.recipes where title='Imported dish' \gset
select t.denied('recipes imported from other websites cannot go to Community', format($$ select public.submit_to_community(%L, true) $$, :'imported1'));
select public.share_link_to_community(:'imported1') as linkcard1 \gset
select t.expect('an imported recipe can be shared as a link card', t.n(format($$ select count(*) from public.recipes where id = %L and scope = 'community' and status = 'pending' $$, :'linkcard1')) = 1);
select t.expect('the link card carries only the name, credit and link', t.n(format($$ select count(*) from public.recipes where id = %L and body->>'kind' = 'link' and body->>'dir' = '' and jsonb_array_length(body->'ings') = 0 and body->'src'->>'url' = 'https://example.com/dish/' and body->'src'->>'author' = 'Someone Else' $$, :'linkcard1')) = 1);
select t.denied('a link card can only be shared once while waiting or live', format($$ select public.share_link_to_community(%L) $$, :'imported1'));
insert into public.recipes(owner_id, scope, title, body) values (:'c1', 'private', 'Adapted dish', '{"adapted": {"author": "Someone Else", "name": "A Blog", "url": "https://example.com/dish/"}, "dir": "My own steps."}');
select id as adapted1 from public.recipes where title='Adapted dish' \gset
select t.denied('a recipe without an original link cannot be shared as a link card', format($$ select public.share_link_to_community(%L) $$, :'adapted1'));
select t.expect('an adapted recipe (own wording, credited) can go to Community', public.submit_to_community(:'adapted1', true) is not null);
reset role;

-- ---- sharing and approval -----------------------------------------------------
select t.login(:'s1'); set role authenticated;
select id as sam1 from public.recipes where title='Sam Soup 1' \gset
select t.denied('sharing needs the rights confirmation', format($$ select public.submit_to_community(%L, false) $$, :'sam1'));
select public.submit_to_community(:'sam1', true) as sub_id \gset
select t.expect('submission is pending with the author name', (select status||'/'||author_name from public.recipes where id=:'sub_id') = 'pending/Sam');
select t.denied('cannot submit the same recipe twice', format($$ select public.submit_to_community(%L, true) $$, :'sam1'));
select t.expect('author can see own pending copy', t.n(format($$ select count(*) from public.recipes where id=%L $$, :'sub_id')) = 1);
update public.recipes set status='approved', title='Edited after' where id=:'sub_id';
select t.expect('author cannot edit or self-approve the shared copy', (select status||'/'||title from public.recipes where id=:'sub_id') = 'pending/Sam Soup 1');
update public.recipes set scope='community', status='approved' where id=:'sam1';
select t.expect('author cannot flip a private recipe to Community', (select scope from public.recipes where id=:'sam1') = 'private');
reset role;

select t.login(:'s2'); set role authenticated;
select t.expect('pending recipes are hidden from other students', t.n(format($$ select count(*) from public.recipes where id=%L $$, :'sub_id')) = 0);
reset role;
select t.login(:'admin_id'); set role authenticated;
select t.expect('admin sees pending submissions', t.n(format($$ select count(*) from public.recipes where id=%L and status='pending' $$, :'sub_id')) = 1);
update public.recipes set status='approved', review_note='Nice one' where id=:'sub_id';
reset role;
select t.login(:'s2'); set role authenticated;
select t.expect('approved recipes show in Community for everyone', t.n(format($$ select count(*) from public.recipes where id=%L $$, :'sub_id')) = 1);
reset role;
select t.login(:'c2'); set role authenticated;
select t.expect('clients see Community too', t.n(format($$ select count(*) from public.recipes where id=%L $$, :'sub_id')) = 1);
reset role;
select t.login(:'s1'); set role authenticated;
update public.recipes set title='Sam Soup 1 v2' where title='Sam Soup 1' and scope='private';
select t.expect('editing the private original does not change Community',
  (select title from public.recipes where id=:'sub_id') = 'Sam Soup 1'
  and (select title from public.recipes where id=:'sam1') = 'Sam Soup 1 v2');
delete from public.recipes where id=:'sub_id';
select t.expect('author can withdraw from Community', t.n(format($$ select count(*) from public.recipes where id=%L $$, :'sub_id')) = 0);
select t.expect('withdrawing keeps the private original', t.n($$ select count(*) from public.recipes where scope='private' and owner_id=auth.uid() $$) = 2);
reset role;

-- ---- people management --------------------------------------------------------
select t.login(:'s1'); set role authenticated;
select t.denied('students cannot make invites', $$ select public.create_invite('student') $$);
update public.profiles set role='admin' where id=:'s1';
select t.expect('people cannot promote themselves', (select role from public.profiles where id=:'s1') = 'student');
select t.expect('people cannot see other profiles', t.n($$ select count(*) from public.profiles $$) = 1);
select t.expect('students cannot read invites (empty or denied)', t.n($$ select count(*) from public.invites $$) = 0);
select t.expect('students cannot read settings', t.n($$ select count(*) from public.app_settings $$) = 0);
reset role;

update public.restaurants set seat_limit = 2 where id=:'r1';
select t.login(:'c1'); set role authenticated;
select public.create_invite('restaurant', :'r1', 'owner', 50, 365) as staff_code \gset
select t.denied('owner cannot invite to another restaurant', format($$ select public.create_invite('restaurant', %L) $$, :'r2'));
reset role;
select t.expect('owner invites are forced to single-use staff', (select member_role||'/'||max_uses from public.invites where code=:'staff_code') = 'staff/1');
insert into auth.users(email, raw_user_meta_data) values ('st1@x.test', jsonb_build_object('invite_code', :'staff_code'));
select id as st1 from auth.users where email='st1@x.test' \gset
select t.login(:'c1'); set role authenticated;
select public.create_invite('restaurant', :'r1') as staff_code2 \gset
reset role;
select t.denied('seat limit blocks extra staff', format($$ insert into auth.users(email, raw_user_meta_data) values ('st2@x.test', jsonb_build_object('invite_code', %L)) $$, :'staff_code2'));

select t.login(:'st1'); set role authenticated;
select t.expect('staff see their restaurant collection', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 1);
select t.denied('staff cannot invite', format($$ select public.create_invite('restaurant', %L) $$, :'r1'));
select t.denied('staff cannot remove colleagues', format($$ select public.remove_member(%L, %L) $$, :'r1', :'c1'));
reset role;

-- ---- restaurant teams add their own recipes; the chef's stay read-only (add_restaurant_kitchen.sql)
select t.login(:'st1'); set role authenticated;
insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (:'st1', :'r1', 'restaurant', 'Staff Salsa', '{}');
select t.expect('staff can add a recipe to their restaurant', t.n($$ select count(*) from public.recipes where title='Staff Salsa' $$) = 1);
update public.recipes set title='Staff Salsa 2' where title='Staff Salsa';
select t.expect('staff can change a recipe they added', t.n($$ select count(*) from public.recipes where title='Staff Salsa 2' $$) = 1);
update public.recipes set title='hacked' where title='Alpha House Gumbo';
delete from public.recipes where title='Alpha House Gumbo';
select t.expect('staff cannot change or delete the chef''s recipe', t.n($$ select count(*) from public.recipes where title='Alpha House Gumbo' $$) = 1);
select t.denied('staff cannot add to another restaurant', format($$ insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (%L, %L, 'restaurant', 'Elsewhere', '{}') $$, :'st1', :'r2'));
select t.denied('staff cannot add a recipe in the chef''s name', format($$ insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (%L, %L, 'restaurant', 'Forged', '{}') $$, :'admin_id', :'r1'));
update public.recipes set restaurant_id = :'r2', scope = 'private' where title='Staff Salsa 2';
reset role;
select t.expect('a team recipe cannot be moved out of the restaurant', (select restaurant_id::text || scope from public.recipes where title='Staff Salsa 2') = :'r1' || 'restaurant');
select t.login(:'c1'); set role authenticated;
insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (:'c1', :'r1', 'restaurant', 'Owner Slaw', '{}');
update public.recipes set title='Owner edit' where title='Staff Salsa 2';
select t.expect('the owner can change any recipe the team added', t.n($$ select count(*) from public.recipes where title='Owner edit' $$) = 1);
delete from public.recipes where title='Alpha House Gumbo';
select t.expect('the owner cannot delete the chef''s recipe either', t.n($$ select count(*) from public.recipes where title='Alpha House Gumbo' $$) = 1);
reset role;
select t.login(:'st1'); set role authenticated;
update public.recipes set title='staff hack' where title='Owner Slaw';
delete from public.recipes where title='Owner Slaw';
select t.expect('staff cannot change or delete the owner''s recipe', t.n($$ select count(*) from public.recipes where title='Owner Slaw' $$) = 1);
delete from public.recipes where title='Owner edit';
select t.expect('staff can delete a recipe they added', t.n($$ select count(*) from public.recipes where title='Owner edit' $$) = 0);
-- costing is the owner's to share (add_restaurant_team.sql): staff start with no access
select t.denied('staff without costing access cannot start the price book', format($$ insert into public.restaurant_kitchen(restaurant_id, prices) values (%L, '{}') $$, :'r1'));
reset role;
select t.expect('restaurants start on the Self-service package, keeping their own prices',
  (select package = 'self_service' and costing_tier = 'self_service' from public.restaurants where id = :'r1'));
select t.login(:'c1'); set role authenticated;
insert into public.restaurant_kitchen(restaurant_id, prices) values (:'r1', '{"items": {"flour": {"p": 0.5, "per": "lb"}}}');
select t.expect('the owner keeps one price book', t.n($$ select count(*) from public.restaurant_kitchen $$) = 1);
select t.expect('the owner sees the team with emails and costing access',
  (select string_agg(email || ':' || member_role || ':' || costing, ',' order by email) from public.restaurant_team(:'r1')) = 'c1@x.test:owner:edit,st1@x.test:staff:none');
reset role;
select t.expect('the price book records who changed it', (select updated_by from public.restaurant_kitchen where restaurant_id = :'r1') = :'c1');
select t.login(:'st1'); set role authenticated;
select t.expect('staff without costing access cannot see it', t.n($$ select count(*) from public.restaurant_kitchen $$) = 0);
select t.denied('staff cannot list the team', format($$ select * from public.restaurant_team(%L) $$, :'r1'));
select t.denied('staff cannot give themselves costing access', format($$ select public.set_member_costing(%L, %L, 'edit') $$, :'r1', :'st1'));
update public.restaurant_members set costing = 'edit' where user_id = :'st1';
reset role;
select t.expect('nor by changing their membership', (select costing from public.restaurant_members where user_id = :'st1') = 'none');
select t.login(:'c1'); set role authenticated;
select public.set_member_costing(:'r1', :'st1', 'view');
select t.denied('costing access is for staff, not owners', format($$ select public.set_member_costing(%L, %L, 'none') $$, :'r1', :'c1'));
reset role;
select t.login(:'st1'); set role authenticated;
select t.expect('staff the owner lets view can see the costing', t.n($$ select count(*) from public.restaurant_kitchen $$) = 1);
update public.restaurant_kitchen set prices = '{}' where restaurant_id = :'r1';
reset role;
select t.expect('but not change it', (select prices -> 'items' ? 'flour' from public.restaurant_kitchen where restaurant_id = :'r1'));
select t.login(:'c1'); set role authenticated;
select public.set_member_costing(:'r1', :'st1', 'edit');
reset role;
select t.login(:'st1'); set role authenticated;
update public.restaurant_kitchen set prices = jsonb_set(prices, '{items,sugar}', '{"p": 1, "per": "lb"}') where restaurant_id = :'r1';
reset role;
select t.expect('staff the owner lets edit can change it', (select prices -> 'items' ? 'sugar' and prices -> 'items' ? 'flour' from public.restaurant_kitchen where restaurant_id = :'r1')
  and (select updated_by from public.restaurant_kitchen where restaurant_id = :'r1') = :'st1');
-- help messages, kept for the admin
select t.login(:'st1'); set role authenticated;
insert into public.restaurant_messages(restaurant_id, topic, body, author_id, status) values (:'r1', 'A recipe', 'How long does the slaw keep?', :'c1', 'done');
select t.expect('a team member can send a help message and see it', t.n($$ select count(*) from public.restaurant_messages $$) = 1);
update public.restaurant_messages set status = 'done';
reset role;
select t.expect('it is theirs and open, whatever they tried', (select author_id = :'st1' and status = 'open' from public.restaurant_messages limit 1));
select t.login(:'c2'); set role authenticated;
select t.denied('another restaurant cannot send for this one', format($$ insert into public.restaurant_messages(restaurant_id, body) values (%L, 'x') $$, :'r1'));
select t.expect('or read its messages', t.n($$ select count(*) from public.restaurant_messages $$) = 0);
reset role;
select t.login(:'admin_id'); set role authenticated;
update public.restaurant_messages set status = 'done';
select t.expect('the admin reads and closes help messages', t.n($$ select count(*) from public.restaurant_messages where status = 'done' $$) = 1);
reset role;
select t.login(:'st1'); set role authenticated;
select t.login(:'c2'); set role authenticated;
select t.expect('another restaurant cannot see the price book', t.n($$ select count(*) from public.restaurant_kitchen $$) = 0);
update public.restaurant_kitchen set prices = '{}' where restaurant_id = :'r1';
reset role;
select t.login(:'s1'); set role authenticated;
select t.denied('students cannot make a price book', format($$ insert into public.restaurant_kitchen(restaurant_id, prices) values (%L, '{}') $$, :'r2'));
reset role;
select t.expect('nobody outside changed it', (select prices -> 'items' ? 'flour' from public.restaurant_kitchen where restaurant_id = :'r1'));
update public.restaurants set subscription_status = 'canceled' where id = :'r1';
select t.login(:'c1'); set role authenticated;
select t.denied('a lapsed restaurant cannot add recipes', format($$ insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (%L, %L, 'restaurant', 'Late', '{}') $$, :'c1', :'r1'));
update public.restaurant_kitchen set prices = '{}' where restaurant_id = :'r1';
delete from public.recipes where title = 'Owner Slaw';
reset role;
select t.expect('a lapsed restaurant cannot change its price book or recipes',
  (select prices -> 'items' ? 'flour' from public.restaurant_kitchen where restaurant_id = :'r1') and t.n($$ select count(*) from public.recipes where title='Owner Slaw' $$) = 1);
update public.restaurants set subscription_status = 'active' where id = :'r1';
select t.login(:'admin_id'); set role authenticated;
delete from public.recipes where title = 'Owner Slaw';
select t.expect('the chef can delete anything in a collection', t.n($$ select count(*) from public.recipes where title='Owner Slaw' $$) = 0);
reset role;
-- costing tiers (add_costing_tiers.sql): on managed costing the ingredient prices are the admin's
update public.restaurants set package = 'managed' where id = :'r1';
select t.expect('the Managed package sets managed costing', (select costing_tier from public.restaurants where id = :'r1') = 'managed');
update public.restaurants set costing_tier = 'self_service' where id = :'r1';
select t.expect('and the costing follows the package, not a stray change', (select costing_tier from public.restaurants where id = :'r1') = 'managed');
select t.login(:'c1'); set role authenticated;
update public.restaurant_kitchen set prices = jsonb_set(jsonb_set(prices, '{items,flour}', '{"p": 9, "per": "lb"}'), '{target}', '25') where restaurant_id = :'r1';
update public.restaurants set package = 'self_service' where id = :'r1';
reset role;
select t.expect('on managed costing the owner cannot change ingredient prices', (select prices #>> '{items,flour,p}' from public.restaurant_kitchen where restaurant_id = :'r1') = '0.5');
select t.expect('but can change their target food cost %', (select prices ->> 'target' from public.restaurant_kitchen where restaurant_id = :'r1') = '25');
select t.expect('and cannot change the package themselves', (select package = 'managed' and costing_tier = 'managed' from public.restaurants where id = :'r1'));
select t.login(:'st1'); set role authenticated;
update public.restaurant_kitchen set prices = jsonb_set(prices, '{items}', '{}') where restaurant_id = :'r1';
reset role;
select t.expect('staff with costing access cannot clear the prices either', (select prices -> 'items' ? 'flour' and prices -> 'items' ? 'sugar' from public.restaurant_kitchen where restaurant_id = :'r1'));
select t.login(:'admin_id'); set role authenticated;
update public.restaurant_kitchen set prices = jsonb_set(prices, '{items,flour}', '{"p": 0.6, "per": "lb"}') where restaurant_id = :'r1';
reset role;
select t.expect('the admin keeps their prices for them', (select prices #>> '{items,flour,p}' from public.restaurant_kitchen where restaurant_id = :'r1') = '0.6');
update public.restaurants set package = 'managed' where id = :'r2';
select t.login(:'c2'); set role authenticated;
insert into public.restaurant_kitchen(restaurant_id, prices) values (:'r2', '{"items": {"salt": {"p": 1, "per": "lb"}}, "target": 30}');
reset role;
select t.expect('a managed restaurant starting its price book starts with no prices of its own',
  (select prices -> 'items' = '{}'::jsonb and prices ->> 'target' = '30' from public.restaurant_kitchen where restaurant_id = :'r2'));
select t.login(:'c1'); set role authenticated;
select t.expect('owner can list the team', t.n($$ select count(*) from public.restaurant_members $$) = 2);
select t.denied('last owner cannot be removed', format($$ select public.remove_member(%L, %L) $$, :'r1', :'c1'));
select public.remove_member(:'r1', :'st1');
select t.expect('owner can remove staff', t.n($$ select count(*) from public.restaurant_members $$) = 1);
reset role;
select t.login(:'st1'); set role authenticated;
select t.expect('removed staff lose access', t.n($$ select count(*) from public.recipes where scope='restaurant' $$) = 0);
reset role;

-- ---- photos -------------------------------------------------------------------
-- uploads: only into your own folders
select t.login(:'s1'); set role authenticated;
insert into storage.objects(bucket_id, name) values ('photos', 'recipes/' || :'s1' || '/soup.jpg');
insert into storage.objects(bucket_id, name) values ('photos', 'library/' || :'s1' || '/lib.jpg');
insert into storage.objects(bucket_id, name) values ('photos', 'avatars/' || :'s1' || '/me.jpg');
select t.denied('students cannot upload into someone else''s folder', format($$ insert into storage.objects(bucket_id, name) values ('photos', 'recipes/%s/x.jpg') $$, :'s2'));
select t.denied('students cannot upload outside the photo folders', $$ insert into storage.objects(bucket_id, name) values ('photos', 'other/x.jpg') $$);
update public.recipes set photo = 'recipes/' || :'s1' || '/soup.jpg' where id = :'sam1';
select t.expect('a student can put a photo on their own recipe', (select photo from public.recipes where id = :'sam1') like 'recipes/%/soup.jpg');
update public.profiles set avatar = 'avatars/' || :'s1' || '/me.jpg' where id = :'s1';
reset role;
select t.login(:'s2'); set role authenticated;
insert into storage.objects(bucket_id, name) values ('photos', 'recipes/' || :'s2' || '/mine.jpg');
insert into public.recipes(owner_id, scope, title, body) values (:'s2', 'private', 'Sue Stew', '{}');
select t.denied('a recipe cannot point at someone else''s photo',
  format($$ update public.recipes set photo = 'recipes/%s/soup.jpg' where title = 'Sue Stew' $$, :'s1'));
select t.expect('other students cannot see a private recipe photo', t.n($$ select count(*) from storage.objects where name like '%/soup.jpg' $$) = 0);
select t.expect('other students cannot see someone''s library photos', t.n($$ select count(*) from storage.objects where name like 'library/%' $$) = 0);
select t.expect('signed-in people can see profile photos', t.n($$ select count(*) from storage.objects where name like 'avatars/%' $$) = 1);
delete from storage.objects where name like '%/soup.jpg' or name like 'avatars/%';
reset role;
select t.expect('people cannot delete someone else''s photos', t.n($$ select count(*) from storage.objects where name like '%/soup.jpg' or name like 'avatars/%' $$) = 2);
set role anon;
select t.expect('signed-out visitors cannot see photos', t.n($$ select count(*) from storage.objects $$) = 0);
reset role;

-- sharing carries the photo; it becomes visible to others once approved
select t.login(:'s1'); set role authenticated;
select public.submit_to_community(:'sam1', true) as sub2 \gset
select t.expect('the shared copy keeps the photo', (select photo from public.recipes where id = :'sub2') like 'recipes/%/soup.jpg');
reset role;
select t.login(:'s2'); set role authenticated;
select t.expect('a pending recipe''s photo stays hidden', t.n($$ select count(*) from storage.objects where name like '%/soup.jpg' $$) = 0);
reset role;
select t.login(:'admin_id'); set role authenticated;
update public.recipes set status = 'approved' where id = :'sub2';
reset role;
select t.login(:'s2'); set role authenticated;
select t.expect('an approved Community photo is visible to everyone signed in', t.n($$ select count(*) from storage.objects where name like '%/soup.jpg' $$) = 1);
select t.expect('Community shows the author''s profile photo', (select avatar from public.community_avatars() where id = :'s1') like 'avatars/%');
select t.expect('library photos stay private even then', t.n($$ select count(*) from storage.objects where name like 'library/%' $$) = 0);
reset role;

-- restaurant collections: photos follow the collection's access
select t.login(:'admin_id'); set role authenticated;
insert into storage.objects(bucket_id, name) values ('photos', 'recipes/' || :'admin_id' || '/gumbo.jpg');
update public.recipes set photo = 'recipes/' || :'admin_id' || '/gumbo.jpg' where title = 'Alpha House Gumbo';
select t.expect('admin can see every photo', t.n($$ select count(*) from storage.objects $$) = 5);
reset role;
select t.login(:'c1'); set role authenticated;
select t.expect('active restaurant staff see their collection''s photos', t.n($$ select count(*) from storage.objects where name like '%/gumbo.jpg' $$) = 1);
reset role;
select t.login(:'c2'); set role authenticated;
select t.expect('other restaurants cannot see them', t.n($$ select count(*) from storage.objects where name like '%/gumbo.jpg' $$) = 0);
reset role;
select t.login(:'s1'); set role authenticated;
select t.expect('students cannot see collection photos', t.n($$ select count(*) from storage.objects where name like '%/gumbo.jpg' $$) = 0);
reset role;

-- ---- deleting a restaurant --------------------------------------------------------
select t.login(:'admin_id'); set role authenticated;
insert into public.restaurants(name, subscription_status) values ('Gamma Grill', 'active');
select id as r3 from public.restaurants where name='Gamma Grill' \gset
select public.create_invite('restaurant', :'r3', 'owner', 1, 14) as own3_code \gset
reset role;
insert into auth.users(email, raw_user_meta_data) values ('c3@x.test', jsonb_build_object('invite_code', :'own3_code'));
select id as c3 from auth.users where email='c3@x.test' \gset
select t.login(:'admin_id'); set role authenticated;
insert into public.recipes(owner_id, restaurant_id, scope, title, body) values (:'admin_id', :'r3', 'restaurant', 'Gamma Grits', '{}');
reset role;
select t.login(:'c3'); set role authenticated;
delete from public.restaurants where id = :'r3';
reset role;
select t.expect('restaurant owners cannot delete their restaurant', t.n(format($$ select count(*) from public.restaurants where id=%L $$, :'r3')) = 1);
select t.login(:'admin_id'); set role authenticated;
delete from public.restaurants where id = :'r3';
reset role;
select t.expect('admin can delete a restaurant', t.n(format($$ select count(*) from public.restaurants where id=%L $$, :'r3')) = 0);
select t.expect('its collection goes with it', t.n($$ select count(*) from public.recipes where title='Gamma Grits' $$) = 0);
select t.expect('its staff lose membership', t.n(format($$ select count(*) from public.restaurant_members where user_id=%L $$, :'c3')) = 0);
select t.expect('its invite codes go with it', t.n(format($$ select count(*) from public.invites where code=%L $$, :'own3_code')) = 0);
select t.expect('staff keep their accounts', t.n(format($$ select count(*) from auth.users where id=%L $$, :'c3')) = 1);

-- ---- signed-out visitors ------------------------------------------------------
set role anon;
select t.denied('signed-out visitors cannot read recipes', $$ select * from public.recipes $$);
select t.denied('signed-out visitors cannot read invites', $$ select * from public.invites $$);
select t.denied('signed-out visitors cannot call actions', $$ select public.create_invite('student') $$);
reset role;

-- ---- per-person data ------------------------------------------------------------
select t.login(:'c1'); set role authenticated;
insert into public.user_data(user_id, stars) values (:'c1', '["a","b"]');
select t.expect('people can save their own stars', t.n($$ select jsonb_array_length(stars) from public.user_data $$) = 2);
select t.denied('people cannot write someone elses data', format($$ insert into public.user_data(user_id, stars) values (%L, '[]') $$, :'admin_id'));
reset role;
select t.login(:'admin_id'); set role authenticated;
select t.expect('even the admin account cannot read other peoples stars through the app', t.n($$ select count(*) from public.user_data $$) = 0);
reset role;
set role anon;
select t.denied('signed-out visitors cannot read stars', $$ select * from public.user_data $$);
reset role;
select t.login(:'c1'); set role authenticated;
select t.denied('stars must be a list', $$ update public.user_data set stars = '{"a":1}' $$);
reset role;

-- ---- admin lists: codes and people ---------------------------------------------
select t.login(:'admin_id'); set role authenticated;
select t.expect('admin sees the student code as used up, with who used it',
  (select status = 'used up' and 'Sam' = any(used_by) from public.admin_list_invites() where code = :'stu_code'));
select public.create_invite('student', null, 'staff', 5, 30) as cancel_code \gset
select public.cancel_invite(:'cancel_code');
select t.expect('a cancelled code shows as cancelled', (select status from public.admin_list_invites() where code = :'cancel_code') = 'cancelled');
select t.denied('a code cannot be cancelled twice', format($$ select public.cancel_invite(%L) $$, :'cancel_code'));
select t.expect('admin sees people with their email and code',
  (select email = 's1@x.test' and invite_code = :'stu_code' and role = 'student' from public.admin_list_people() where id = :'s1'));
select t.expect('people list shows restaurant owners',
  (select 'Alpha Grill (owner)' = any(restaurants) from public.admin_list_people() where id = :'c1'));
reset role;
select t.denied('a cancelled code cannot be used to sign up',
  format($$ insert into auth.users(email, raw_user_meta_data) values ('late@x.test', jsonb_build_object('invite_code', %L)) $$, :'cancel_code'));

select t.login(:'s1'); set role authenticated;
select t.denied('students cannot list invite codes', $$ select * from public.admin_list_invites() $$);
select t.denied('students cannot list people', $$ select * from public.admin_list_people() $$);
select t.denied('students cannot cancel codes', format($$ select public.cancel_invite(%L) $$, :'stu_code'));
select t.denied('students cannot remove people', format($$ select public.admin_remove_person(%L) $$, :'s2'));
reset role;
set role anon;
select t.denied('signed-out visitors cannot list people', $$ select * from public.admin_list_people() $$);
reset role;

-- removing someone: private recipes go, their approved Community recipes stay
select t.login(:'admin_id'); set role authenticated;
select public.create_invite('student', null, 'staff', 1, 30) as leave_code \gset
reset role;
insert into auth.users(email, raw_user_meta_data) values ('leaver@x.test', jsonb_build_object('invite_code', :'leave_code', 'display_name', 'Lee'));
select id as leaver from auth.users where email='leaver@x.test' \gset
insert into public.recipes(owner_id, scope, title, body) values (:'leaver', 'private', 'Lee Private Pie', '{}');
insert into public.recipes(owner_id, scope, status, title, body, author_name) values (:'leaver', 'community', 'approved', 'Lee Shared Slaw', '{}', 'Lee');
insert into public.recipes(owner_id, scope, status, title, body, author_name) values (:'leaver', 'community', 'pending', 'Lee Waiting Gravy', '{}', 'Lee');
select t.login(:'admin_id'); set role authenticated;
select t.denied('admin cannot remove their own account', format($$ select public.admin_remove_person(%L) $$, :'admin_id'));
select t.denied('the only owner of a restaurant cannot be removed', format($$ select public.admin_remove_person(%L) $$, :'c1'));
select public.admin_remove_person(:'leaver');
reset role;
select t.expect('removed person has no account', t.n(format($$ select count(*) from auth.users where id = %L $$, :'leaver')) = 0);
select t.expect('removed person''s private recipes are gone', t.n($$ select count(*) from public.recipes where title = 'Lee Private Pie' $$) = 0);
select t.expect('removed person''s pending submissions are gone', t.n($$ select count(*) from public.recipes where title = 'Lee Waiting Gravy' $$) = 0);
select t.expect('removed person''s Community recipe stays, still credited to them',
  (select owner_id = :'admin_id' and author_name = 'Lee' from public.recipes where title = 'Lee Shared Slaw'));

-- deleting your own account: everything of theirs goes; admins and only-owners are refused
select t.login(:'admin_id'); set role authenticated;
select public.create_invite('student', null, 'staff', 1, 30) as quit_code \gset
reset role;
insert into auth.users(email, raw_user_meta_data) values ('quitter@x.test', jsonb_build_object('invite_code', :'quit_code', 'display_name', 'Quinn'));
select id as quitter from auth.users where email='quitter@x.test' \gset
insert into public.recipes(owner_id, scope, title, body) values (:'quitter', 'private', 'Quinn Private Pie', '{}');
insert into public.recipes(owner_id, scope, status, title, body, author_name) values (:'quitter', 'community', 'approved', 'Quinn Shared Slaw', '{}', 'Quinn');
set role anon;
select t.denied('signed-out visitors cannot delete an account', $$ select public.delete_my_account() $$);
reset role;
select t.login(:'admin_id'); set role authenticated;
select t.denied('the admin cannot delete their own account in the app', $$ select public.delete_my_account() $$);
reset role;
select t.login(:'c1'); set role authenticated;
select t.denied('the only owner of a restaurant cannot delete their account', $$ select public.delete_my_account() $$);
reset role;
select t.login(:'quitter'); set role authenticated;
select public.delete_my_account();
reset role;
select t.expect('a deleted account is gone', t.n(format($$ select count(*) from auth.users where id = %L $$, :'quitter')) = 0);
select t.expect('a deleted account''s profile is gone', t.n(format($$ select count(*) from public.profiles where id = %L $$, :'quitter')) = 0);
select t.expect('a deleted account''s recipes are all gone, Community ones too',
  t.n($$ select count(*) from public.recipes where title like 'Quinn %' $$) = 0);
select t.expect('other people are untouched', t.n(format($$ select count(*) from auth.users where id = %L $$, :'s1')) = 1);

-- households: a shared shopping list
select t.login(:'s1'); set role authenticated;
select public.create_household('The Jones House') as hh_code \gset
select t.denied('you can only be in one household', $$ select public.create_household('Second') $$);
select public.save_household_list('{"items":[],"extras":[{"id":"x1","text":"Milk"}],"done":[]}', 5);
reset role;
select t.login(:'s2'); set role authenticated;
select t.expect('outsiders cannot see a household', t.n($$ select count(*) from public.households $$) = 0);
select t.denied('outsiders cannot save a household list', $$ select public.save_household_list('{}', 1) $$);
select t.denied('a wrong code is refused', $$ select public.join_household('NOPE99') $$);
select public.join_household(lower(:'hh_code'));
select t.expect('a member sees the shared list', (select list -> 'extras' -> 0 ->> 'text' = 'Milk' from public.household_info()));
select t.expect('a member sees who is in it', (select array_length(members, 1) = 2 from public.household_info()));
select public.save_household_list('{"items":[],"extras":[],"done":["x1"]}', 1);
select t.expect('saves always move the version on', (select list_at = 6 from public.household_info()));
select public.leave_household();
select t.expect('after leaving, the household is out of sight', t.n($$ select count(*) from public.households $$) = 0);
reset role;
select t.expect('the household stays while someone is in it', t.n($$ select count(*) from public.households where name = 'The Jones House' $$) = 1);
select t.login(:'s1'); set role authenticated;
select public.leave_household();
reset role;
select t.expect('the last one out removes the household', t.n($$ select count(*) from public.households where name = 'The Jones House' $$) = 0);
set role anon;
select t.denied('signed-out visitors cannot make a household', $$ select public.create_household('X') $$);
reset role;

-- ---- invite links and invite requests ----------------------------------------
select t.login(:'admin_id'); set role authenticated;
select public.create_invite('student', null, 'staff', 1, 30) as link_code \gset
reset role;
set role anon;
select t.expect('anyone with a link can see the invite still works', (select status = 'active' and kind = 'student' from public.invite_info(:'link_code')));
select t.expect('a made-up code shows as not found', (select status from public.invite_info('NOPE12345678')) = 'not found');
select t.expect('lower case codes from links still match', (select status from public.invite_info(lower(:'link_code'))) = 'active');
select public.request_invite('Ana', 'Ana@Example.com', 'student', 'In Chef Joseph''s Tuesday class');
select public.request_invite('Ana B', 'ana@example.com', 'student', 'asked twice');
select t.denied('a bad email is refused', $$ select public.request_invite('X', 'not-an-email', 'other', '') $$);
select t.denied('people without an account cannot read requests', $$ select * from public.invite_requests $$);
reset role;
select t.expect('asking twice keeps one waiting request with the latest details',
  t.n($$ select count(*) from public.invite_requests where email = 'ana@example.com' and status = 'waiting' and name = 'Ana B' $$) = 1);
select t.login(:'s1'); set role authenticated;
select t.expect('students cannot see invite requests', t.n($$ select count(*) from public.invite_requests $$) = 0);
reset role;
select t.login(:'admin_id'); set role authenticated;
select t.expect('the admin sees invite requests', t.n($$ select count(*) from public.invite_requests $$) = 1);
update public.invite_requests set status = 'invited', handled_at = now() where email = 'ana@example.com';
select t.expect('admin can mark a request handled', t.n($$ select count(*) from public.invite_requests where status = 'invited' $$) = 1);
select t.expect('admin code list includes the emailed-to column', (select count(*) >= 1 from public.admin_list_invites() where email is null));
reset role;
set role anon;
select public.request_invite('Ana', 'ana@example.com', 'student', 'again later');
reset role;
select t.expect('after an invite, the same person can ask again', t.n($$ select count(*) from public.invite_requests where email = 'ana@example.com' $$) = 2);

-- ---- open sign-up switch ------------------------------------------------------
set role anon;
select t.expect('anyone can see sign-up is invite-only', public.signup_open() = false);
select t.expect('a new invite request says it is new', public.request_invite('Bo', 'bo@example.com', 'other', '') = true);
select t.expect('asking again says it is not new', public.request_invite('Bo', 'BO@example.com', 'other', 'again') = false);
reset role;
select t.login(:'s1'); set role authenticated;
update public.app_settings set open_signup = true;
reset role;
-- ---- edit history (add_recipe_versions.sql)
select t.login(:'c1'); set role authenticated;
insert into public.recipes(owner_id, scope, title, body) values (:'c1', 'private', 'History Soup', '{"dir": "v1"}');
update public.recipes set body = '{"dir": "v2"}' where title = 'History Soup';
update public.recipes set title = 'History Soup!' where title = 'History Soup';
update public.recipes set title = 'History Soup!' where title = 'History Soup!';
select t.expect('each change keeps the version before it (and only real changes do)',
  t.n($$ select count(*) from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where r.title = 'History Soup!' $$) = 2);
select t.expect('the owner reads their recipe''s history, oldest content kept', (select v.body ->> 'dir' from public.recipe_versions v join public.recipes r on r.id = v.recipe_id
  where r.title = 'History Soup!' order by v.id limit 1) = 'v1');
select t.denied('nobody writes history by hand', format($$ insert into public.recipe_versions(recipe_id, title, body) values ((select id from public.recipes where title = 'History Soup!'), 'x', '{}') $$));
reset role;
select t.expect('who replaced it is recorded', (select replaced_by from public.recipe_versions order by id desc limit 1) = :'c1');
select t.login(:'s2'); set role authenticated;
select t.expect('others cannot read someone''s recipe history', t.n($$ select count(*) from public.recipe_versions $$) = 0);
reset role;
select t.login(:'admin_id'); set role authenticated;
select t.expect('the admin can', t.n($$ select count(*) from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where r.title = 'History Soup!' $$) = 2);
reset role;
do $$ declare i int; begin for i in 1..35 loop update public.recipes set body = jsonb_build_object('dir', 'v' || (i + 2)) where title = 'History Soup!'; end loop; end $$;
select t.expect('only the last 30 versions are kept', t.n($$ select count(*) from public.recipe_versions v join public.recipes r on r.id = v.recipe_id where r.title = 'History Soup!' $$) = 30);
select id as hist from public.recipes where title = 'History Soup!' \gset
delete from public.recipes where title = 'History Soup!';
select t.expect('deleting a recipe deletes its history', t.n(format($$ select count(*) from public.recipe_versions where recipe_id = %L $$, :'hist')) = 0);
select t.expect('students cannot open sign-up', public.signup_open() = false);
select t.login(:'admin_id'); set role authenticated;
update public.app_settings set open_signup = true;
reset role;
select t.expect('the admin can open sign-up', public.signup_open() = true);
update public.app_settings set open_signup = false;
update public.app_settings set open_signup = true;
insert into auth.users(email) values ('walkin@x.test');
select t.expect('open sign-up makes free students', (select role from public.profiles where id=(select id from auth.users where email='walkin@x.test')) = 'student');

\o
\echo
select case when ok then 'PASS' else 'FAIL' end as result, name, case when ok then '' else detail end as detail from t.r order by n;
select count(*) filter (where ok) || ' of ' || count(*) || ' checks passed' as summary from t.r;
