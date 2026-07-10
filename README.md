# Zipo Fare Logger — shared web app

A small, invite-only web app for logging London taxi fares over time so you can
analyse when prices are highest. Every logged-in user reads and writes one
**shared feed** of observations, stored in Supabase. There is no public sign-up:
you add users by hand.

The app is plain static files — no build step, no framework, no bundler.

```
index.html          the fare logger (gated: redirects to login if signed out)
login.html          email + password sign-in
config.js           <-- paste your Supabase URL + anon key here
supabase-setup.sql  table + Row Level Security policies (run once)
netlify.toml        Netlify deploy config
README.md           this file
```

---

## What each user can do

- **Read:** every authenticated user sees *all* entries (the shared feed) and
  the same shared config (route/tier catalogue, weights, sampling mode).
- **Write:** every authenticated user can add, edit, and delete entries, and can
  edit the shared config.
- **Deleting requires a password.** Both the big "Clear data" wipe *and*
  deleting a single row prompt for the password set near the top of the script
  in `index.html` (`DELETE_PASSWORD`, default `Zipo2026` — change it). This is a
  UI safeguard against accidental deletion of shared data, not a security
  boundary: it's visible in the page source, so change it before going live.
- **Logged-out visitors:** see nothing — the page redirects to the login screen,
  and the database rejects all reads/writes (enforced by RLS, not just the UI).

> If you'd rather each user only edit/delete *their own* rows, see the note at
> the bottom of `supabase-setup.sql` — it's a one-line change to the update and
> delete policies.

---

## Setup — do these in order

### 1. Create a Supabase project

1. Go to https://supabase.com, sign in, and click **New project**.
2. Give it a name (e.g. `zipo-fare-logger`), set a strong database password
   (you won't need it for this app), pick a region near London, and create it.
3. Wait ~1–2 minutes for it to finish provisioning.

### 2. Create the table + security policies

1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase-setup.sql` from this folder, copy the whole file, paste it in.
3. Click **Run**. You should see "Success. No rows returned."

This creates the `fare_entries` table, indexes, turns on Row Level Security, and
adds the shared-feed policies (authenticated users only).

### 3. Get your URL and anon key, and put them in `config.js`

1. Go to **Project Settings** (gear icon) → **API**.
2. Copy two values:
   - **Project URL** — looks like `https://abcdxyz.supabase.co`
   - **Project API keys → `anon` `public`** — a long string starting `eyJ...`
3. Open `config.js` and paste them in:

   ```js
   window.ZIPO_CONFIG = {
     SUPABASE_URL: "https://abcdxyz.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi...your-anon-key..."
   };
   ```

   The **anon key is safe to ship in the browser** — it can only do what your RLS
   policies allow, and those require a signed-in user. **Never** paste the
   `service_role` key here; it bypasses RLS.

### 4. Turn OFF public sign-up

So that only people you add can get in:

1. Go to **Authentication** → **Sign In / Providers** (or **Providers**).
2. Under **Email**, make sure the provider is **enabled** (users still need to
   sign *in*), then turn **OFF** "Allow new users to sign up".
   - Depending on the dashboard version this toggle is labelled
     **"Allow new users to sign up"** and may live under
     **Authentication → Settings** as **"Disable sign-ups" / "User Signups"**.
     Whichever wording you see, set it so that self-service sign-up is **not**
     allowed.
3. (Optional but recommended) Under **Authentication → Providers → Email**, turn
   **OFF** "Confirm email" so the accounts you create by hand are usable
   immediately without an email round-trip. If you leave confirmation on, use the
   "Auto Confirm User" option when creating each user (see next step).

### 5. Add users manually

You are the only one who can create accounts. Two ways:

**A. Via the dashboard (easiest):**

1. Go to **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter the person's **email** and a **password**.
3. Tick **Auto Confirm User** (so they can log in right away).
4. Click **Create user**. Send them the email + password out-of-band; they can
   sign in immediately.

**B. Via an admin script (for adding several at once):**

Run this locally with Node. It uses the **service_role** key, which must stay on
your machine and never go into the app or Git.

```bash
# install once
npm install @supabase/supabase-js

# create add-user.mjs with the contents below, then:
node add-user.mjs someone@ridezipo.com 'their-strong-password'
```

```js
// add-user.mjs
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://abcdxyz.supabase.co';       // your Project URL
const SERVICE_ROLE_KEY = 'eyJ...service_role...';         // Settings → API → service_role (keep secret!)

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node add-user.mjs <email> <password>');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,   // user can log in immediately
});
if (error) { console.error('Failed:', error.message); process.exit(1); }
console.log('Created user:', data.user.email, data.user.id);
```

To remove someone's access later, delete them under **Authentication → Users**.

### 6. Test locally (optional but wise)

Because the app loads `config.js` and talks to Supabase over HTTPS, opening
`index.html` from a `file://` path can hit browser restrictions. Serve the folder
over HTTP instead:

```bash
# any one of these, from inside this folder:
python3 -m http.server 8080
# or
npx serve .
```

Then visit http://localhost:8080/login.html, sign in with a user you created,
and confirm you can log a fare and see it appear. Open the same URL in a second
browser (or an incognito window) signed in as a different user to confirm the
feed is shared.

### 7. Deploy to Netlify

**Option A — drag-and-drop (fastest):**

1. Make sure `config.js` has your real URL + anon key saved.
2. Go to https://app.netlify.com → **Add new site** → **Deploy manually**.
3. Drag this entire folder onto the drop zone.
4. Netlify gives you a live URL. Visit it, and you'll land on the login page.

**Option B — Git (nicer for updates):**

1. Push this folder to a GitHub/GitLab repo. `config.js` holds only the public
   anon key, so it's fine to commit. (Do **not** commit any service_role key or
   the `add-user.mjs` script if you filled its key in.)
2. In Netlify: **Add new site** → **Import an existing project** → pick the repo.
3. Leave the build command empty and publish directory as `.` (the included
   `netlify.toml` already sets this). Deploy.
4. Future `git push`es redeploy automatically.

---

## How it fits together

- **`login.html`** signs the user in with Supabase Auth (email + password). On
  success it redirects to `index.html`. If already signed in, it skips straight
  to the app.
- **`index.html`** checks for a session on load. No session → redirect to
  `login.html`. With a session → it shows the logger, loads the shared feed, and
  every capture/edit/delete writes straight to Supabase. A small coloured dot
  next to your email shows sync status (green = synced, amber = saving,
  red = error). "Sign out" ends the session and returns to login.
- **Config** (the route/tier catalogue, weights, and sampling mode under
  "Config") is **shared across all users** — stored as a single row in the
  `app_config` table. Editing it writes through to Supabase (debounced), and
  everyone picks up the change on their next load. Concurrent edits are
  last-write-wins.
- **Export CSV** still works and now exports the shared feed you're viewing.

## The data

Table `fare_entries`, one row per logged vehicle-tier observation. Numeric fields
are nullable — an empty input or a skipped tier is stored as `NULL` (cleaner for
analysis than a sentinel string). Each row also records `created_by` (the user
who logged it) and `created_at` (server timestamp), which are handy for
"when are fares highest" queries in the Supabase SQL editor.

## Security notes

- Access control is enforced by **Row Level Security in Postgres**, not just the
  UI. Even someone holding the anon key and hitting the API directly gets nothing
  without a valid signed-in session.
- The **anon key in `config.js` is meant to be public.** The key that must stay
  secret is the **service_role** key — keep it off the web app and out of any
  public repo.
- Turning off public sign-up (step 4) is what makes this invite-only. Re-check
  that toggle after any Supabase dashboard update.
