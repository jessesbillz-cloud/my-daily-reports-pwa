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

IMPORTANT: For each field, also estimate its position on the page so we can fill values back onto this template later. Provide:
- "page": which page the field is on (1-indexed)
- "x": approximate x position in points (from left edge, 72 points = 1 inch, letter width = 612 points)
- "y": approximate y position in points FROM THE TOP of the page (letter height = 792 points). For a field near the top of the page y should be small (e.g. 50-100), for fields near the bottom y should be large (e.g. 600-750).
- "w": approximate width of the value area in points
- "h": approximate height of the value area in points
- "fontSize": estimated font size in points used for the value text (typically 8-12)

The x position should be where the VALUE starts (after the label), not where the label starts. For example if "Project Name: Woodland Park" appears on the page, x should point to where "Woodland Park" starts.

For multi-line fields like Notes or Observations, provide a larger h value and set "multiline": true.

Return ONLY valid JSON with no other text or markdown:
{"editable":[{"name":"Date","value":"","autoFill":"date","page":1,"x":180,"y":120,"w":120,"h":14,"fontSize":10},{"name":"IOR Notes","value":"","voiceEnabled":true,"page":1,"x":72,"y":500,"w":468,"h":100,"fontSize":10,"multiline":true}],"locked":[{"name":"Project Name","value":"Woodland Park MS","page":1,"x":180,"y":85,"w":200,"h":14,"fontSize":10}]}

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
        max_tokens: 2048,
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
