# My Daily Reports - Complete Audit Synopsis
### Lighthouse + Gemini Code Audits | March 17, 2026

---

## How to Read This Document

Every finding from both the Lighthouse performance audit and the Gemini code audits (covering 10+ files) has been categorized into one of four tiers:

- **DEFINITELY DO** - Legitimate issues that improve security, reliability, or performance without changing your architecture or design
- **STRONGLY CONSIDER** - Good ideas that align with your workflow but need careful implementation on your terms
- **MAYBE / CONTEXT-DEPENDENT** - Valid in theory but may not apply to how you specifically built things
- **DEFINITELY SKIP** - Bad advice, already handled, doesn't understand your setup, or would break things

Each item includes a brief note on why it lands where it does.

---

## TIER 1: DEFINITELY DO

These are non-structural improvements that make your existing code more robust without redesigning anything.

### 1. Duplicate Notification Prevention (send-reminders)
**Gemini says:** Cron running every 30 min with a 2-hour reminder window = 4 duplicate notifications per user.
**Verdict:** This is a real bug. Adding a `last_reminder_sent_at` column to track when the last reminder went out is a simple DB column + one conditional check. No structural change. Just smarter logic.
**Pros:** Stops users from getting spammed. Simple fix.
**Cons:** None meaningful.

### 2. JWT/Auth Verification on Edge Functions (multiple functions)
**Gemini says:** Several functions accept `user_id` from the request body without verifying the caller's identity.
**Verdict:** This is legitimate and important. Functions like `manage-subscription`, `submit-inspection`, and `update-inspection` should verify the JWT from the Authorization header rather than trusting `user_id` from the body. This doesn't change your architecture at all --- it's just adding a few lines at the top of each function.
**Pros:** Prevents anyone with your function URL from spoofing actions as another user. Critical for Stripe-related functions.
**Cons:** None. This is standard security hygiene.

### 3. Base64 Sanitization (describe-photo)
**Gemini says:** If the frontend sends a Data URL prefix (`data:image/jpeg;base64,...`), the Claude API call will fail.
**Verdict:** Simple guard. One line to strip the prefix if present. No downside.
**Pros:** Prevents silent failures on photo audits.
**Cons:** None.

### 4. Payload Size Validation (send-report, describe-photo, parse-template)
**Gemini says:** Large base64 payloads can crash Deno isolates (OOM).
**Verdict:** Adding a size check immediately after `req.json()` is a 5-line guard that prevents your edge functions from dying on oversized uploads.
**Pros:** Prevents crashes, gives users a clear error message instead of a mysterious 500.
**Cons:** None.

### 5. Webhook Replay Protection (email-webhook)
**Gemini says:** You verify the timestamp is within 5 minutes (good), but don't check the `svix-id` to prevent replay attacks within that window.
**Verdict:** Worth doing. Check if the `resend_email_id` already exists in `email_events` before processing. Simple SELECT before INSERT.
**Pros:** Prevents an attacker from replaying a valid webhook to skew metrics or spam your DB.
**Cons:** One extra DB query per webhook, negligible cost.

### 6. Atomic Increment for Suppression Counts (email-webhook)
**Gemini says:** Your read-then-write pattern on `event_count` can lose counts under concurrency.
**Verdict:** Real issue. A Postgres RPC function that does the increment atomically is cleaner and more reliable. This is a DB-level fix, not a code architecture change.
**Pros:** Accurate suppression counts. No lost data.
**Cons:** Requires creating one small RPC function.

### 7. Color Contrast Fix (Lighthouse - Accessibility)
**Lighthouse says:** 8 elements have insufficient contrast ratios.
**Verdict:** This is a CSS-only fix. Adjusting text/background color values to meet WCAG AA standards. No layout or design changes.
**Pros:** Better readability, accessibility compliance.
**Cons:** Some colors may shift slightly, but we can keep them on-brand.

### 8. Add `<main>` Landmark (Lighthouse - Accessibility)
**Lighthouse says:** Missing a main landmark for screen readers.
**Verdict:** Wrapping your primary content area in a `<main>` tag. One HTML tag. Zero visual change.
**Pros:** Screen reader navigation, accessibility score jumps.
**Cons:** None.

### 9. Console Error Cleanup (Lighthouse - Best Practices)
**Lighthouse says:** Babel deoptimization warnings logged to console.
**Verdict:** These are noise from the in-browser Babel compilation. When we eventually address the Babel situation (see Tier 2), these go away automatically. In the meantime, they're cosmetic.

### 10. Better Error Logging in Edge Functions (multiple)
**Gemini says:** Console.error calls don't include enough context (missing request_id, job_id, etc.).
**Verdict:** Adding the relevant ID to your existing log lines is trivial and makes debugging in Supabase logs dramatically easier.
**Pros:** Faster debugging. Zero risk.
**Cons:** None.

---

## TIER 2: STRONGLY CONSIDER

These are good improvements that align with your goals but are bigger lifts or need to be done on your timeline and your terms.

### 1. Lazy-Load Heavy Libraries (Lighthouse - Performance)
**Lighthouse says:** `pdf-lib` (99KB), `mammoth` (86KB), `pdf.js` (66KB) all load eagerly.
**Verdict:** These libraries are only needed when a user actually opens a PDF or DOCX. Dynamic `import()` or injecting the script tag on demand would cut ~250KB from initial load.
**Pros:** Faster initial load, better Speed Index.
**Cons:** Slight delay the first time a user triggers a PDF/DOCX action. Need to test that lazy loading doesn't break your current flow.

### 2. Babel Standalone Replacement (Lighthouse - Performance)
**Lighthouse says:** `babel.min.js` consumes 7.8 seconds of main-thread time.
**Verdict:** This is the single biggest performance bottleneck. It's why your Performance score is 45. However, this is also how your entire app compiles JSX in the browser, which is core to how you've built things. Moving to a build step (Vite/esbuild) would be a major architectural shift. Only do this when you're ready for it.
**Pros:** Performance score would likely jump to 80-90. Time to Interactive drops from 8.3s to under 2s.
**Cons:** Requires a build pipeline. Changes your development workflow. Not a quick fix.

### 3. Timezone-Aware Reminders (send-reminders)
**Gemini says:** `new Date()` in Edge Functions = UTC. Users in other timezones get reminders at wrong times.
**Verdict:** Valid concern IF your users span multiple timezones. If everyone is in the same timezone (California), this is less urgent. But storing timezone in profiles future-proofs you.
**Pros:** Correct reminder timing regardless of user location.
**Cons:** Requires adding a `timezone` column to profiles and adjusting the cron logic. Medium lift.

### 4. ICS Line Folding (calendar-feed)
**Gemini says:** Long DESCRIPTION fields can break some calendar parsers (Outlook, old Apple Calendar).
**Verdict:** Legitimate RFC 5545 compliance issue. A small helper function that wraps lines at 75 characters. Low risk, high compatibility.
**Pros:** Better calendar app compatibility.
**Cons:** Minimal effort. Worth doing when you're touching that function anyway.

### 5. Calendar Token Security (calendar-feed)
**Gemini says:** Anyone who knows a user's ID or slug can download their entire schedule via the public URL.
**Verdict:** Adding a `calendar_token` column to profiles and requiring it as a query parameter is a solid security improvement. Not urgent if the slugs are hard to guess, but good practice.
**Pros:** Prevents unauthorized access to private schedules.
**Cons:** Existing calendar subscriptions would need to be re-subscribed with the new token URL.

### 6. Promise.allSettled for Batch Notifications (send-reminders, submit-inspection)
**Gemini says:** Sequential `await` in loops = slow and fragile at scale.
**Verdict:** Valid optimization. Running notifications in parallel with `Promise.allSettled` is faster and more resilient (one failure doesn't kill the batch). Do this when you're scaling.
**Pros:** Faster execution, better fault tolerance.
**Cons:** Slightly more complex error handling. Need to review Supabase rate limits.

### 7. File Upload Size/Type Validation (submit-inspection)
**Gemini says:** No server-side checks for file size or file type on uploads.
**Verdict:** Your client already validates (25MB PDFs, 10MB images), but server-side validation is defense-in-depth. Someone could bypass the client.
**Pros:** Prevents storage quota exhaustion and potential XSS from malicious file types.
**Cons:** Small amount of additional validation code.

---

## TIER 3: MAYBE / CONTEXT-DEPENDENT

These suggestions have merit in general but may not apply to your specific setup.

### 1. Race Conditions on Conflict Detection (submit-inspection, update-inspection)
**Gemini says:** Two simultaneous requests could both pass the conflict check and double-book.
**Reality:** This matters at high concurrency. If your inspection volume is moderate (not hundreds of simultaneous submissions), this is unlikely to occur. A Postgres unique constraint or DB function would fix it, but it's not urgent unless you're seeing actual double-bookings.

### 2. Replace Regex XML Parsing with Proper Parser (parse-template)
**Gemini says:** Regex for DOCX XML is brittle and will break on complex documents.
**Reality:** Depends on how diverse your templates are. If you control the templates and they're consistent, regex works fine. If users upload wildly different Word docs, this could be an issue. Monitor for failures before investing in a full XML parser.

### 3. Cache Template Fingerprints (parse-template)
**Gemini says:** 1,000 users using the same template means 1,000 LLM calls.
**Reality:** Great optimization IF you have many users on the same template. If most users have unique templates, caching doesn't help much. Worth building when you hit scale, not before.

### 4. Hardcoded Timezone in Calendar Feed
**Gemini says:** `America/Los_Angeles` is hardcoded.
**Reality:** If all your users are in California, this is fine. Only matters when you expand to other regions.

### 5. Auto-Select After "Add Person" (schedule.html / request.html)
**Gemini says:** Auto-select the most recently added person in the dropdown.
**Reality:** Nice UX touch, but your current flow might be intentional (you may want users to explicitly choose). Only do this if users have complained.

### 6. Client-Side Image Compression Before Upload
**Gemini says:** Would help users on cellular connections.
**Reality:** Depends on your user base. If inspectors are mostly on WiFi or strong LTE, this adds complexity for minimal gain. If you get complaints about slow uploads in the field, revisit.

### 7. Offline Service Worker for Scheduling Form
**Gemini says:** Add offline support for field use.
**Reality:** You already have a service worker (`sw.js`). The question is whether it caches the scheduling form. Worth verifying, but may already be partially handled.

### 8. AbortController Timeout on Claude API Calls (describe-photo)
**Gemini says:** Claude API can hang; wrap in a 30s timeout.
**Reality:** Good defensive programming. Low effort. But if you haven't seen hangs in practice, it's a "nice to have."

---

## TIER 4: DEFINITELY SKIP

These are suggestions that don't understand your architecture, would break things, or are already handled.

### 1. "Use the Stripe SDK Instead of Fetch"
**Gemini says:** Import the Stripe library for Deno.
**Why skip:** Your fetch-based approach works. The Stripe SDK adds a dependency, and your current implementation handles what you need. Adding a library for "type safety" isn't worth the complexity in a Deno Edge Function.

### 2. "Replace Hardcoded API Keys in Client-Side Code"
**Gemini says:** The Supabase Anon Key is exposed.
**Why skip:** This is how Supabase client-side apps work BY DESIGN. The anon key is meant to be public. Security comes from RLS policies, not key secrecy. Gemini doesn't understand Supabase's security model here.

### 3. "Use a Proper XML Parser for DOCX"
**Gemini says:** Use fast-xml-parser instead of regex.
**Why skip (for now):** Adding a full XML parsing library to an Edge Function increases bundle size and complexity. Your regex approach works for YOUR templates. Only revisit if you see parsing failures in production.

### 4. "The Model Name is Wrong" (describe-photo)
**Gemini says:** `claude-haiku-4-5-20251001` doesn't exist; should be `claude-3-5-haiku-20241022`.
**Why skip:** Gemini's knowledge is outdated. `claude-haiku-4-5-20251001` is a valid current model identifier. Ignore this.

### 5. "Refactor the Fallback Owner Lookup to SQL"
**Gemini says:** Replace the JS `.find()` loop with a database query using a slug column.
**Why skip:** This would require adding a `slug` column to your jobs table and migrating data. Your current approach works and the 200-job limit is reasonable for your scale. Over-engineering.

### 6. "Use mammoth.js for DOCX Layout"
**Gemini says:** Use mammoth to convert DOCX to HTML for better coordinate extraction.
**Why skip:** mammoth.js is already one of your heavy libraries that Lighthouse flagged as wasting bytes. Adding MORE dependency on it is the opposite direction.

### 7. Any Gemini "Suggested Code Snippets"
**Gemini provides** full code blocks throughout.
**Why skip:** Per your instructions, no external code goes in. Only code I write goes into the app. Their snippets also don't account for your specific patterns, naming conventions, or architecture.

### 8. "Remove the Final renderCal() Call"
**Gemini says:** The first `renderCal()` at the bottom of the script is redundant.
**Why skip:** This is a micro-optimization that could introduce a flash of empty content if the load order ever changes. The cost of an extra render is negligible. Leave it for stability.

---

## Summary Scorecard

| Category | Definitely Do | Strongly Consider | Maybe | Skip |
|----------|:---:|:---:|:---:|:---:|
| Security | 3 | 2 | 1 | 1 |
| Performance | 2 | 3 | 2 | 2 |
| Reliability | 3 | 2 | 2 | 0 |
| Accessibility | 2 | 0 | 0 | 0 |
| UX/Code Quality | 1 | 0 | 3 | 2 |
| **Totals** | **11** | **7** | **8** | **5** |

---

## Recommended Order of Operations

If we tackle the "Definitely Do" items first, here's the priority sequence:

1. JWT auth verification on edge functions (security, highest impact)
2. Duplicate notification prevention (user-facing bug)
3. Base64 sanitization + payload size guards (quick wins)
4. Webhook replay protection + atomic increments (data integrity)
5. Accessibility fixes - contrast + main landmark (quick CSS/HTML)
6. Error logging improvements (quality of life for debugging)

The "Strongly Consider" items can be phased in as we go, with the Babel replacement being the biggest single performance win but also the biggest lift.

---

*This document reflects the audits as-is. No code has been written or changed. All implementation will be done by Claude per Jesse's specifications.*
