# Hosted database (Supabase)

`schema.sql` creates the tables and the access rules for the shared, logged-in version of the app:
accounts, restaurants with staff logins, private / restaurant / community recipes, the approval
flow, invite-only sign-up, and the free-plan limit.

## Set up a new project
1. Create a Supabase project (free plan is fine while testing).
2. In `schema.sql`, change `CHANGE-ME@example.com` to the email you will use as admin.
3. Supabase dashboard > SQL Editor > New query > paste `schema.sql` > Run.
4. Authentication > Providers > Email: keep **Confirm email** switched ON.
5. Sign up in the app with the admin email straight away.

Everyone else needs an invite code (made with `create_invite`) until `app_settings.open_signup` is set to true.

## Test the rules
    bash supabase/test/run.sh

This starts a throwaway local PostgreSQL, loads small stand-ins for Supabase's login system, applies
`schema.sql` and tries to break it (reading other people's recipes, promoting yourself, skipping the
invite code, and so on). It needs the PostgreSQL server binaries installed.

## Adding things later
`add_user_data.sql` adds the table that keeps starred recipes with the person's account. Projects created
before it existed run it once in the SQL Editor (it is safe to run again). New projects get it from `schema.sql`.

## Not done yet
Stripe billing (which would set `restaurants.subscription_status`) is not connected.

## Who can see what
Passwords are stored hashed by Supabase and never visible to anyone. Every table has row-level security, so
the app's logins can only read what the rules allow. Two honest caveats: the administrator account can read
every recipe, including private ones (that is how approvals work), and you as the project owner can see
everything in the Supabase dashboard. Tell students and clients that "private" means private from other users.
