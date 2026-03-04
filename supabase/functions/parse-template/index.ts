import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { file_base64, file_type, file_name } = await req.json();

    const mediaType = file_name.endsWith(".pdf")
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: mediaType, data: file_base64 },
            },
            {
              type: "text",
              text: "Analyze this inspection report template. Find all fillable fields by looking for patterns like \"Label:\" or \"Label: value\" or form fields.\n\nFor each field, determine if it CHANGES per report or STAYS THE SAME across reports.\n\nFields that typically CHANGE per report: Date, Report Date, Inspection Date, Report Number, Report No, DR#, Notes, IOR Notes, Observations, Comments, Work Observed, Weather, Hours, Time In, Time Out, Temperature.\n\nFields that typically STAY THE SAME: Project Name, Owner, Client, District, DSA File #, DSA App #, Contractor, Architect, Engineer, Inspector, IOR, Address, Location, Project No.\n\nReturn ONLY valid JSON with no other text or markdown:\n{\"editable\":[{\"name\":\"Date\",\"value\":\"\",\"autoFill\":\"date\"},{\"name\":\"IOR Notes\",\"value\":\"\",\"voiceEnabled\":true}],\"locked\":[{\"name\":\"Project Name\",\"value\":\"Woodland Park MS\"}]}\n\nautoFill can be \"date\" or \"increment\" (for report numbers). voiceEnabled=true for notes/observations fields. Include the current value if one exists in the template.",
            },
          ],
        }],
      }),
    });

    const data = await response.json();
    const text = data.content?.map((c: any) => c.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
