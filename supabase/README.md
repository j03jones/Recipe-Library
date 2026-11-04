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

## Not done yet
The app does not talk to this database yet, there is no admin screen for approvals, and Stripe
billing (which would set `restaurants.subscription_status`) is not connected.
