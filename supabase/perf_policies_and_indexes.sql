-- Database speed-ups from the Supabase advisor (2026-11-17). Run after schema.sql and the add_*.sql files.
-- Nothing here changes who can see or change what.
--
-- 1. Row-level security policies call auth.uid() once per query instead of once per row:
--    `(select auth.uid())` is worked out once and reused (Supabase lint 0003, auth_rls_initplan).
-- 2. Foreign keys get covering indexes, so deleting an account or restaurant does not scan whole tables
--    (lint 0001, unindexed_foreign_keys).

alter policy clients_own_read on public.clients using (user_id = (select auth.uid()));

alter policy profiles_read on public.profiles using ((id = (select auth.uid())) or is_admin());
alter policy profiles_update_self on public.profiles
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

alter policy recipes_read on public.recipes using (
  is_admin() or (owner_id = (select auth.uid()))
  or ((scope = 'community') and (status = 'approved'))
  or ((scope = 'restaurant') and is_member(restaurant_id) and restaurant_readable(restaurant_id)));   -- add_restaurant_access.sql
alter policy recipes_insert_own on public.recipes
  with check ((owner_id = (select auth.uid())) and (scope = 'private') and (status = 'approved'));
alter policy recipes_update_own on public.recipes
  using ((owner_id = (select auth.uid())) and (scope = 'private'))
  with check ((owner_id = (select auth.uid())) and (scope = 'private') and (status = 'approved'));
alter policy recipes_delete_own on public.recipes
  using ((owner_id = (select auth.uid())) and (scope = any (array['private', 'community'])));
alter policy recipes_kitchen_insert on public.recipes
  with check ((scope = 'restaurant') and (owner_id = (select auth.uid())) and (status = 'approved')
    and is_member(restaurant_id) and restaurant_active(restaurant_id));
alter policy recipes_kitchen_update on public.recipes
  using ((scope = 'restaurant') and is_member(restaurant_id) and restaurant_active(restaurant_id)
    and (not is_admin_user(owner_id)) and ((owner_id = (select auth.uid())) or is_owner(restaurant_id)))
  with check ((scope = 'restaurant') and is_member(restaurant_id));
alter policy recipes_kitchen_delete on public.recipes
  using ((scope = 'restaurant') and is_member(restaurant_id) and restaurant_active(restaurant_id)
    and (not is_admin_user(owner_id)) and ((owner_id = (select auth.uid())) or is_owner(restaurant_id)));

alter policy members_read on public.restaurant_members
  using (is_admin() or (user_id = (select auth.uid())) or is_member(restaurant_id));
alter policy restaurant_messages_read on public.restaurant_messages
  using (is_admin() or (author_id = (select auth.uid())));
alter policy user_data_own on public.user_data
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create index if not exists client_menu_templates_chef on public.client_menu_templates (chef_id);
create index if not exists households_created_by on public.households (created_by);
create index if not exists invites_created_by on public.invites (created_by);
create index if not exists invites_restaurant on public.invites (restaurant_id);
create index if not exists recipe_versions_replaced_by on public.recipe_versions (replaced_by);
create index if not exists restaurant_kitchen_updated_by on public.restaurant_kitchen (updated_by);
create index if not exists restaurant_messages_author on public.restaurant_messages (author_id);
