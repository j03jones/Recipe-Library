-- Dishes made of more than one recipe (v0.25.0): a main plus sides, sauces or a starch.
-- Safe to run more than once. Run after add_clients.sql.
--
-- The client still sees one dish (client_meals: name, ingredient names, allergens, nutrition), so
-- nothing they can read changes. Which recipes make it up is chef-only, next to the main recipe in
-- client_meal_private: parts = [{ recipe_id, title, factor, grocery_cost }, ...], main first, or []
-- for a one-recipe dish (recipe_id / factor / grocery_cost stay the main recipe and the dish total).

alter table public.client_meal_private add column if not exists parts jsonb not null default '[]';
alter table public.client_meal_private drop constraint if exists client_meal_private_parts_check;
alter table public.client_meal_private add constraint client_meal_private_parts_check
  check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) <= 12);

-- PostgREST caches the table shapes; ask it to look again so the app can use the new column at once.
notify pgrst, 'reload schema';
