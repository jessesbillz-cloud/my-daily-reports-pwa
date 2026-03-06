import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PROMPT = `Analyze this inspection report template. Find all fillable fields by looking for patterns like "Label:" or "Label: value" or table cells with labels and values.

For each field, determine if it CHANGES per report or STAYS THE SAME across reports.

Fields that typically CHANGE per report: Date, Report Date, Inspection Date, Report Number, Report No, DR#, Notes, IOR Notes, Observations, Comments, Work Observed, Weather, Hours, Time In, Time Out, Temperature, Correction Notices Issued, Observation Letters Issued.

Fields that typically STAY THE SAME: Project Name, Owner, Client, District, DSA File #, DSA App #, Contractor, Architect, Engineer, Inspector, IOR, Project Inspector, Address, Location, Project No, Project Manager, Jurisdiction.

Return ONLY valid JSON with no other text or markdown:
{"editable":[{"name":"Date","value":"","autoFill":"date"},{"name":"IOR Notes","value":"","voiceEnabled":true}],"locked":[{"name":"Project Name","value":"Woodland Park MS"}]}

autoFill can be "date" or "increment" (for report numbers). voiceEnabled=true for notes/observations fields. Include the current value if one exists in the template.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { file_base64, file_name, file_text } = body;
    const isPdf = file_name.toLowerCase().endsWith(".pdf");

    let content;

    if (isPdf) {
      content = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: file_base64 },
        },
        { type: "text", text: PROMPT },
      ];
    } else {
      content = [
        {
          type: "text",
          text: "Here is the extracted text content from a Word document (.docx) inspection report template:\n\n---\n" + (file_text || "No text extracted") + "\n---\n\n" + PROMPT,
        },
      ];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message || "Anthropic API error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = data.content?.map((c) => c.text || "").join("") || "";
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
