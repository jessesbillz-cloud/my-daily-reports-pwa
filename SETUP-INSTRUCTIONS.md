# My Daily Reports — Setup Instructions

Copy-paste these steps into Claude or follow them yourself.

---

## PART 1: Supabase Database (SQL Editor)

Go to: https://supabase.com/dashboard → your project → SQL Editor

Paste the entire contents of `supabase-setup.sql` and click **Run**.

This creates:
- Missing columns on `profiles` (timezone, setup_complete, wizard_completed_at)
- `jobs` table
- `templates` table
- `reports` table
- `inspection_requests` table
- RLS policies on every table (users can only see their own data)
- Storage bucket `report-source-docs` with RLS
- Auto-update timestamps

---

## PART 2: Deploy Edge Functions

Open terminal in the project folder and run these two commands:

```
npx supabase functions deploy parse-template --no-verify-jwt
```

```
npx supabase functions deploy send-report --no-verify-jwt
```

---

## PART 3: Set Environment Variables

Go to: Supabase Dashboard → Project Settings → Edge Functions → Secrets

Add these two secrets:

| Name | Value | Where to get it |
|------|-------|-----------------|
| `ANTHROPIC_API_KEY` | sk-ant-... | https://console.anthropic.com/settings/keys |
| `RESEND_API_KEY` | re_... | https://resend.com/api-keys |

---

## PART 4: Resend Email Setup

1. Go to https://resend.com and create a free account
2. Get your API key (set it in Part 3 above)
3. For testing: Resend lets you send to your own email on the free tier
4. For production: add and verify your domain (mydailyreports.com) in Resend dashboard
5. The default FROM address is `reports@mydailyreports.com` — change it in `supabase/functions/send-report/index.ts` if needed

---

## PART 5: Supabase Auth Settings

Go to: Supabase Dashboard → Authentication → Settings → Email

Decide on these settings:

| Setting | Recommended for Beta | Notes |
|---------|---------------------|-------|
| Enable email signup | ON | Already on |
| Enable email confirmations | OFF | Users can start immediately. Turn ON later for verified emails |
| Minimum password length | 6 | Already set |

---

## PART 6: GitHub Pages Hosting

Option A — Enable GitHub Pages:
1. Go to: https://github.com/jessesbillz-cloud/my-daily-reports-pwa/settings/pages
2. Source: Deploy from a branch
3. Branch: `main`, folder: `/ (root)`
4. Save
5. Your app will be live at: `https://jessesbillz-cloud.github.io/my-daily-reports-pwa/`

Option B — Custom domain:
1. After enabling GitHub Pages, go to the same settings page
2. Enter your custom domain (e.g., `app.mydailyreports.com`)
3. Add a CNAME record in your DNS pointing to `jessesbillz-cloud.github.io`
4. Check "Enforce HTTPS"

---

## PART 7: Update manifest.json (if needed)

If your hosting path is different from `/my-daily-reports-pwa/`, update `start_url` in `manifest.json`:

```json
{
  "start_url": "/",
}
```

For GitHub Pages, the current value `/my-daily-reports-pwa/` is correct.

---

## PART 8: Test the Full Flow

1. Open the app URL in your phone browser
2. Tap "Create Account" — enter name, email, password
3. Go through the setup wizard (5 steps)
4. Create a new job — upload a real PDF template
5. Verify fields parse correctly
6. Fill out a report and tap Submit
7. Test "Download PDF" on the success screen
8. Test "Email to Team" on the success screen
9. Share the URL with someone else — verify they get their own account
10. Test "Add to Home Screen" on iOS and Android
