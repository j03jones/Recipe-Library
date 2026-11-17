-- Edit history for recipes in the database (v0.33.0). Safe to run again. Run after add_restaurant_team.sql.
--
-- Each time a recipe's name, categories or content changes, the version it had before is kept in recipe_versions
-- (the last 30 for each recipe), with when it was saved and who replaced it. Whoever can read a recipe can read its
-- history; restoring an old version is an ordinary change to the recipe, so the usual rules decide who may.

create table if not exists public.recipe_versions (
  id bigint generated always as identity primary key,
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  title text not null,
  categories text[] not null default '{}',
  body jsonb not null,
  saved_at timestamptz,                                   -- when this version was saved
  replaced_by uuid references auth.users (id) on delete set null,
  replaced_at timestamptz not null default now()
);
create index if not exists recipe_versions_recipe on public.recipe_versions (recipe_id, replaced_at desc);

create or replace function public.keep_recipe_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.title is distinct from new.title or old.categories is distinct from new.categories or old.body is distinct from new.body then
    insert into public.recipe_versions (recipe_id, title, categories, body, saved_at, replaced_by)
      values (old.id, old.title, old.categories, old.body, old.updated_at, auth.uid());
    delete from public.recipe_versions v where v.recipe_id = old.id and v.id not in
      (select id from public.recipe_versions where recipe_id = old.id order by replaced_at desc, id desc limit 30);
  end if;
  return new;
end $$;
revoke execute on function public.keep_recipe_version() from public, anon, authenticated;
drop trigger if exists keep_recipe_version on public.recipes;
create trigger keep_recipe_version after update on public.recipes
  for each row execute function public.keep_recipe_version();

alter table public.recipe_versions enable row level security;
-- the recipes' own rules apply inside this check, so it only finds versions of recipes this person may read
drop policy if exists recipe_versions_read on public.recipe_versions;
create policy recipe_versions_read on public.recipe_versions for select to authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_id));
revoke all on public.recipe_versions from anon;
grant select on public.recipe_versions to authenticated;

notify pgrst, 'reload schema';
