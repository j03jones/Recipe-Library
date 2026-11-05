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

## Email (Resend)
Sign-up confirmations and password resets are sent by Supabase. Supabase's built-in sender only
allows a couple of emails an hour, so they go through Resend instead, from
`Jones Ridge Kitchen <hello@mail.jonesridgekitchen.com>` (domain verified in Resend). The app's own
code never touches the Resend key: the site is public, so a key in it could be read by anyone.

1. Resend > API keys: use a key with **Sending access** restricted to `mail.jonesridgekitchen.com`.
2. Supabase > Authentication > **Emails** > **SMTP Settings** (older dashboards: Project Settings >
   Authentication > SMTP Settings) > **Enable Custom SMTP**:
   - Sender email: `hello@mail.jonesridgekitchen.com`, Sender name: `Jones Ridge Kitchen`
   - Host: `smtp.resend.com`, Port: `465`, Username: `resend`, Password: the Resend key
3. Authentication > **Rate Limits**: raise "emails sent per hour" (custom SMTP starts at 30) if needed.
4. Authentication > **URL Configuration**: Site URL `https://recipes.jonesridgekitchen.com`, and add
   `https://recipes.jonesridgekitchen.com/**` to Redirect URLs so reset links can return to the app.
5. Authentication > **Emails** > **Templates**: paste the files from `email-templates/` into the
   matching template, with these subjects:
   - Confirm signup: `confirm-signup.html`, "Confirm your Recipe Library account"
   - Reset password: `reset-password.html`, "Reset your Recipe Library password"
   - Change email address: `change-email.html`, "Confirm your new email address"
   - Magic link: `magic-link.html`, "Your Recipe Library sign-in link"
6. Test: sign up with a spare address and use "Forgot password?" in the app, then check
   resend.com/emails shows both as Delivered.

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
