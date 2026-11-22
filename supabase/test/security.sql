-- Security fixes (add_security_fixes.sql). Run after test.sql (it uses t.* and the admin made there).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
delete from t.r;
update public.app_settings set open_signup = false;

-- the admin email only makes the first admin
select count(*) as admins_before from public.profiles where role = 'admin' \gset
update public.app_settings set admin_email = 'newboss@x.test';
select t.denied('a changed admin email cannot sign up without an invite', $$ insert into auth.users(email) values ('newboss@x.test') $$);
update public.app_settings set open_signup = true;
insert into auth.users(email) values ('newboss@x.test');
select t.expect('a changed admin email does not make a second admin',
  (select role from public.profiles where id = (select id from auth.users where email = 'newboss@x.test')) = 'student');
select t.expect('no new admin appears', t.n($$ select count(*) from public.profiles where role = 'admin' $$) = :admins_before);
update public.app_settings set admin_email = 'admin@x.test';

-- household codes are 10 characters, without 0 or 1
select id as hu from auth.users where email = 'newboss@x.test' \gset
select t.login(:'hu'); set role authenticated;
select public.create_household('Long Code House') as hcode \gset
select t.expect('household codes are 10 characters', char_length(:'hcode') = 10 and :'hcode' !~ '[01]');
select t.denied('the first 6 characters of a code are not enough', format($$ select public.join_household(%L) $$, left(:'hcode', 6)));
select public.leave_household();
reset role;

\o
\echo
select case when ok then 'PASS' else 'FAIL' end as result, name, case when ok then '' else detail end as detail from t.r order by n;
select count(*) filter (where ok) || ' of ' || count(*) || ' checks passed' as summary from t.r;
