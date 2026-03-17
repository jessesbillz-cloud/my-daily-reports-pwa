import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * send-reminders — Runs on a cron schedule (e.g., every 30 min).
 * Checks all jobs with reminder_enabled=true, determines if today is a
 * scheduled report day, and sends ntfy push notifications to users who
 * haven't submitted their report yet.
 *
 * Deploy: supabase functions deploy send-reminders --no-verify-jwt
 * Cron:   Set up via Supabase Dashboard > Database > Extensions > pg_cron
 *         SELECT cron.schedule('send-reminders', '*/30 * * * *',
 *           $$SELECT net.http_post(
 *             url := 'https://wluvkmpncafugdbunlkw.supabase.co/functions/v1/send-reminders',
 *             headers := '{"Authorization": "Bearer <service_role_key>"}'::jsonb
 *           )$$
 *         );
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Map day abbreviations to JS getDay() values
const DAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const now = new Date();
    const todayISO = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const todayDOW = now.getDay(); // 0=Sun

    // 1. Get all jobs with reminders enabled
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id, user_id, name, schedule, schedule_days, reminder_enabled, reminder_time, reminder_hours_before")
      .eq("reminder_enabled", true)
      .eq("is_archived", false);

    if (jobsErr) throw new Error("Failed to query jobs: " + jobsErr.message);
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "No jobs with reminders" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. For each job, check if today is a scheduled day
    const dueJobs: typeof jobs = [];
    for (const job of jobs) {
      const sched = job.schedule || "as_needed";
      let scheduledDays: number[] = [];

      if (sched === "daily_7") scheduledDays = [0, 1, 2, 3, 4, 5, 6];
      else if (sched === "daily_mf") scheduledDays = [1, 2, 3, 4, 5];
      else if (sched === "custom" && Array.isArray(job.schedule_days)) {
        scheduledDays = job.schedule_days.map((d: string) => DAY_MAP[d]).filter((n: number | undefined) => n != null);
      }

      if (scheduledDays.includes(todayDOW)) {
        // Check reminder timing — only send if we're within the reminder window
        // reminder_time is like "5:00 PM", reminder_hours_before is like 2
        const reminderHours = job.reminder_hours_before || 2;
        const reminderTime = job.reminder_time || "5:00 PM";

        // Parse reminder_time to 24h
        const match = reminderTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1]);
          const m = parseInt(match[2]);
          if (match[3].toUpperCase() === "PM" && h !== 12) h += 12;
          if (match[3].toUpperCase() === "AM" && h === 12) h = 0;
          const deadlineMinutes = h * 60 + m;
          const reminderMinutes = deadlineMinutes - (reminderHours * 60);
          const nowMinutes = now.getHours() * 60 + now.getMinutes();

          // Send if we're in the reminder window (between reminder time and deadline)
          if (nowMinutes >= reminderMinutes && nowMinutes <= deadlineMinutes) {
            dueJobs.push(job);
          }
        }
      }
    }

    if (dueJobs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "No reminders due right now" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Check which of these jobs already have today's report submitted
    const jobIds = dueJobs.map(j => j.id);
    const { data: todayReports } = await supabase
      .from("reports")
      .select("job_id, status")
      .in("job_id", jobIds)
      .eq("report_date", todayISO)
      .eq("status", "submitted");

    const submittedJobIds = new Set((todayReports || []).map(r => r.job_id));

    // Filter to only jobs without a submitted report today
    const needsReminder = dueJobs.filter(j => !submittedJobIds.has(j.id));

    if (needsReminder.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "All due reports already submitted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Group by user and send one notification per user
    const userJobs: Record<string, typeof needsReminder> = {};
    for (const job of needsReminder) {
      if (!userJobs[job.user_id]) userJobs[job.user_id] = [];
      userJobs[job.user_id].push(job);
    }

    // Get ntfy topics for these users
    const userIds = Object.keys(userJobs);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, ntfy_topic, push_subscription")
      .in("id", userIds);

    let sentCount = 0;

    // 5. Check dedup — don't send the same reminder twice in one window
    // Use a simple table or just rely on ntfy's idempotency tag
    for (const profile of (profiles || [])) {
      const jobs = userJobs[profile.id];
      if (!jobs || jobs.length === 0) continue;

      const jobNames = jobs.map(j => j.name).join(", ");
      const title = "Report Reminder";
      const body = jobs.length === 1
        ? `Your report for ${jobs[0].name} is due today.`
        : `You have ${jobs.length} reports due today: ${jobNames}`;

      const tag = `reminder-${profile.id}-${todayISO}`;

      // Send via ntfy
      if (profile.ntfy_topic) {
        try {
          await fetch(`https://ntfy.sh/${profile.ntfy_topic}`, {
            method: "POST",
            headers: {
              "Title": title,
              "Priority": "default",
              "Tags": "memo",
              "X-Tag": tag,
            },
            body: body,
          });
          sentCount++;
        } catch (e) {
          console.error("ntfy send failed for", profile.id, e);
        }
      }

      // Also try web push
      if (profile.push_subscription?.endpoint) {
        try {
          await fetch(profile.push_subscription.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "TTL": "86400" },
            body: JSON.stringify({ title, body, tag }),
          });
        } catch (e) {
          console.error("Web push failed for", profile.id, e);
        }
      }
    }

    return new Response(JSON.stringify({ sent: sentCount, checked: needsReminder.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("send-reminders error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
