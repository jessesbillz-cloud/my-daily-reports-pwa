import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function escapeICS(text: string): string {
  return (text || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function formatICSDate(dateStr: string, timeStr?: string): string {
  const d = dateStr.replace(/-/g, "");
  if (timeStr) {
    const parts = timeStr.split(":");
    const t = parts[0] + parts[1] + "00";
    return d + "T" + t;
  }
  return d;
}

function generateUID(id: string): string {
  return `${id}@mydailyreports.org`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("user_id");
    const slug = url.searchParams.get("slug");
    const project = url.searchParams.get("project");

    if (!userId && !slug && !project) {
      return new Response("Missing user_id, slug, or project parameter", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let calendarName = "My Daily Reports";
    let requests: any[] = [];

    if (project) {
      calendarName = `${project.replace(/-/g, " ")} — Schedule`;

      const { data, error } = await supabase
        .from("inspection_requests")
        .select("*")
        .eq("project", project)
        .neq("status", "cancelled")
        .neq("status", "deleted")
        .order("inspection_date", { ascending: true });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      requests = data || [];
    } else {
      let resolvedUserId = userId;

      if (slug && !userId) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id, full_name")
          .eq("slug", slug)
          .single();

        if (!profile) {
          return new Response("Inspector not found", {
            status: 404,
            headers: corsHeaders,
          });
        }
        resolvedUserId = profile.id;
        calendarName = `${profile.full_name || "Inspector"} — Scheduling`;
      } else if (userId) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", userId)
          .single();

        if (profile?.full_name) {
          calendarName = `${profile.full_name} — Scheduling`;
        }
      }

      const { data, error } = await supabase
        .from("inspection_requests")
        .select("*, jobs(name, site_address)")
        .eq("user_id", resolvedUserId)
        .neq("status", "cancelled")
        .neq("status", "deleted")
        .order("requested_date", { ascending: true });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      requests = data || [];
    }

    const TZ = "America/Los_Angeles";

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//My Daily Reports//Scheduling//EN",
      `X-WR-CALNAME:${escapeICS(calendarName)}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-TIMEZONE:${TZ}`,
      "BEGIN:VTIMEZONE",
      `TZID:${TZ}`,
      "BEGIN:STANDARD",
      "DTSTART:19701101T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "TZOFFSETFROM:-0700",
      "TZOFFSETTO:-0800",
      "TZNAME:PST",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "TZOFFSETFROM:-0800",
      "TZOFFSETTO:-0700",
      "TZNAME:PDT",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ];

    const now = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");

    for (const r of requests) {
      const dateField = r.inspection_date || r.requested_date;
      if (!dateField) continue;

      const timeField = r.inspection_time || null;
      const projectName = r.project || r.jobs?.name || "Job";
      const siteAddr = r.location_detail || r.jobs?.site_address || "";

      const inspType =
        r.inspection_type || (r.inspection_types || [])[0] || "Visit";
      const specialType = r.special_type ? ` — ${r.special_type}` : "";
      const summary = `${inspType}${specialType}: ${projectName.replace(/-/g, " ")}`;

      const statusEmoji =
        r.status === "scheduled" || r.status === "confirmed" ? "✅ " : "⏳ ";
      const duration = parseInt(r.duration) || 60;

      const isFlexible = r.flexible_display === "flexible";
      const hasTime = !!timeField && !isFlexible;

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${generateUID(r.id)}`);
      lines.push(`DTSTAMP:${now}`);

      if (hasTime) {
        const dtStart = formatICSDate(dateField, timeField);
        lines.push(`DTSTART;TZID=${TZ}:${dtStart}`);

        const timeParts = timeField.split(":").map(Number);
        const totalMin = timeParts[0] * 60 + timeParts[1] + duration;
        const endH = String(Math.floor(totalMin / 60)).padStart(2, "0");
        const endM = String(totalMin % 60).padStart(2, "0");
        const dtEnd = formatICSDate(dateField, `${endH}:${endM}`);
        lines.push(`DTEND;TZID=${TZ}:${dtEnd}`);
      } else {
        const dtStart = formatICSDate(dateField);
        lines.push(`DTSTART;VALUE=DATE:${dtStart}`);

        const nextDay = new Date(dateField + "T12:00:00");
        nextDay.setDate(nextDay.getDate() + 1);
        const nd = nextDay.toISOString().split("T")[0];
        lines.push(`DTEND;VALUE=DATE:${formatICSDate(nd)}`);
      }

      lines.push(`SUMMARY:${escapeICS(statusEmoji + summary)}`);

      const descParts: string[] = [];
      descParts.push(`Status: ${r.status || "pending"}`);
      if (r.submitted_by) descParts.push(`Submitted by: ${r.submitted_by}`);
      if (r.requester_name)
        descParts.push(`Requested by: ${r.requester_name}`);
      if (r.requester_email) descParts.push(`Email: ${r.requester_email}`);
      if (r.requester_company)
        descParts.push(`Company: ${r.requester_company}`);
      if (r.inspection_identifier)
        descParts.push(`Request #: ${r.inspection_identifier}`);
      if (r.subcontractor) descParts.push(`Subcontractor: ${r.subcontractor}`);
      if (r.notes) descParts.push(`Notes: ${r.notes}`);
      if (isFlexible) descParts.push("Time: Flexible — anytime today");
      lines.push(`DESCRIPTION:${escapeICS(descParts.join("\n"))}`);

      if (siteAddr) {
        lines.push(`LOCATION:${escapeICS(siteAddr)}`);
      }

      // Attach file URLs if present
      const attachUrls = r.file_urls || [];
      for (const url of attachUrls) {
        if (url) lines.push(`ATTACH:${url}`);
      }

      if (r.status === "scheduled" || r.status === "confirmed") {
        lines.push("CATEGORIES:Confirmed");
      } else {
        lines.push("CATEGORIES:Pending");
      }

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    const icsContent = lines.join("\r\n");

    return new Response(icsContent, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="schedule.ics"',
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
