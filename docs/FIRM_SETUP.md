# Firm setup — production one-off (WS8 PR A)

> Operator runbook for standing up the pilot firm on production Supabase and
> Fly. Run once, in order. All SQL is UK English and idempotent where it can be.
> This is a manual owner step — nothing here is applied automatically by the app.

The firm-administration foundation ships two things that need production action:

1. the **migration** `backend/migrations/20260721_01_firm_administration.sql`
   (organisations table, `organisation_id`/`role` on `user_profiles`,
   `organisation_api_keys`), and
2. the **seed** below (create the pilot org, promote the admin, backfill
   existing users) plus the `DEFAULT_ORGANISATION_ID` Fly secret.

Order matters: **apply the migration first, then the seed, then set the secret
and redeploy.** Until `DEFAULT_ORGANISATION_ID` is set, new users remain orgless
(the safe default) and the app behaves exactly as before.

---

## Step 1 — Apply the migration to production Supabase

In the Supabase dashboard → **SQL editor**, paste the **entire contents** of
`backend/migrations/20260721_01_firm_administration.sql` and run it. Paste the
file contents, never a file path — the SQL editor cannot read local files, and
pasting a path silently runs nothing (see `docs/DURABLE_LESSONS.md`).

The migration is additive and uses `if not exists` / `add column if not exists`,
so re-running it is safe.

Verify the new shape before continuing:

```sql
-- organisations + organisation_api_keys exist
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('organisations', 'organisation_api_keys');

-- user_profiles now has organisation_id + role
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_profiles'
  and column_name in ('organisation_id', 'role');
```

Both queries should return the expected rows before you seed.

---

## Step 2 — Create the firm and backfill members (one shot, no copying)

This single statement creates the organisation if it does not exist, finds it
if it does, and assigns every still-orgless user to it as a member. It is safe
to re-run and never overwrites an existing membership. **No placeholder to
replace** — the id is resolved inside the query. (An earlier version of this
guide used a `<ORG_ID>` placeholder that had to be replaced by hand; pasting
it literally fails with `22P02: invalid input syntax for type uuid`.)

```sql
with existing as (
  select id from public.organisations where name = 'Aria Grace Law CIC' limit 1
), created as (
  insert into public.organisations (name)
  select 'Aria Grace Law CIC'
  where not exists (select 1 from existing)
  returning id
), org as (
  select id from existing union all select id from created
)
update public.user_profiles
set organisation_id = (select id from org),
    updated_at = now()
where organisation_id is null;
```

## Step 3 — (merged into Step 2)

Nothing to do — the backfill happened above. Kept as a numbered placeholder so
the remaining step numbers match earlier references.

## Step 4 — Promote the admin

The admin is the profile whose `auth.users` email is
`ezana-haddis@aria-grace.com`. Set the role by joining through `auth.users`:

```sql
update public.user_profiles up
set role = 'admin',
    updated_at = now()
from auth.users au
where au.id = up.user_id
  and lower(au.email) = 'ezana-haddis@aria-grace.com';
```

Verify exactly one admin, in the right firm:

```sql
select au.email, up.role, o.name
from public.user_profiles up
join auth.users au on au.id = up.user_id
left join public.organisations o on o.id = up.organisation_id
where up.role = 'admin';
```

You should see one row: `ezana-haddis@aria-grace.com | admin | Aria Grace Law CIC`.
If that email has not signed up yet, run this step after they do.

---

## Step 5 — Point new users at the firm (Fly secret) and redeploy

Set `DEFAULT_ORGANISATION_ID` so new (and any remaining orgless) users are
auto-assigned to the firm as members on first profile load. First fetch the
firm's id:

```sql
select id from public.organisations where name = 'Aria Grace Law CIC';
```

Copy the UUID it returns, then run the command below **with the UUID pasted in
place of the angle-bracket placeholder (remove the brackets too)** — this is
the one step where a real value must be substituted by hand:

```bash
fly secrets set DEFAULT_ORGANISATION_ID='<paste-the-uuid-here>' --app jessicaoss-api
```

Setting a secret triggers a redeploy. If it does not, redeploy manually:

```bash
cd backend && fly deploy --yes
```

---

## Step 6 — Verify end to end

1. `fly secrets list --app jessicaoss-api` shows `DEFAULT_ORGANISATION_ID`
   (names only — values are never printed).
2. Sign in as the admin and load the account page; the profile response
   (`GET /user/profile`) now carries a `firm` object
   (`{ id, name: "Aria Grace Law CIC", role: "admin", policies: … }`) and
   `isAdmin: true`.
3. Sign in as an ordinary pilot user: `firm.role` is `"member"` and
   `isAdmin` is `false`.
4. A brand-new signup, after its first profile load, is a member of the firm
   (auto-assignment). No admin role is granted automatically — only Step 4 does
   that.

## Rollback / self-hosters

- To detach the firm without data loss, unset the secret
  (`fly secrets unset DEFAULT_ORGANISATION_ID --app jessicaoss-api`) — new users
  go back to orgless, existing memberships remain until cleared.
- Self-hosters who never set `DEFAULT_ORGANISATION_ID` and never seed an
  organisation keep the original per-user behaviour everywhere; the migration
  columns simply sit at their defaults (`organisation_id` null, `role`
  `'member'`).
