# Template Cleanup Guide for My Daily Reports

Before uploading your daily report template to the app, follow these steps to make sure it works smoothly. PDF templates sometimes contain hidden formatting, extra blank pages, or embedded form fields that can interfere with the auto-fill system.

## Why Cleanup Matters

Daily report templates created in Word, Google Docs, or other editors often contain invisible elements like hidden text layers, embedded form fields, extra blank pages meant for printing, and inconsistent cell sizing in tables. These hidden elements can cause the app to place text in the wrong spot, skip pages, or misread your field labels.

## Option A: Clean Up Using Microsoft Copilot

1. Go to [copilot.microsoft.com](https://copilot.microsoft.com)
2. Upload your template PDF
3. Use this prompt:

> Please analyze this PDF template and identify any issues that could cause problems for automated text placement. Specifically look for: hidden text layers, embedded form fields, extra blank pages with little or no content, inconsistent table cell widths, overlapping text elements, or non-standard fonts. Then create a clean version of this document as a new PDF with these issues resolved. Keep the exact same visual layout, tables, headers, logos, and formatting — just remove any hidden or problematic elements. If there are blank continuation pages at the end (like pages that just say "Additional Documentation" or have a single "Date" field), remove those pages entirely.

4. Download the cleaned PDF that Copilot generates
5. Upload that cleaned version to My Daily Reports

## Option B: Clean Up Using Google Gemini

1. Go to [gemini.google.com](https://gemini.google.com)
2. Upload your template PDF
3. Use this prompt:

> Analyze this PDF for any hidden formatting issues that could interfere with automated field detection and text overlay. Look for: hidden text behind visible text, embedded form fields or annotations, blank or near-empty pages at the end of the document, table cells with inconsistent or overlapping boundaries, and invisible text or whitespace characters. Create a clean copy of this PDF that preserves the exact visual layout (all tables, headers, colors, logos, field labels) but removes any hidden layers, form fields, annotations, and blank continuation pages. Output as a new clean PDF.

4. Download the cleaned version
5. Upload to My Daily Reports

## Option C: Manual Cleanup in Word

If you have the original Word (.docx) file:

1. Open the document in Microsoft Word
2. Go to **File → Options → Display** and check "Show all formatting marks" to see hidden characters
3. Delete any blank pages at the end that are just placeholder pages for "Additional Documentation and Photos" — the app adds photo pages automatically
4. For tables: make sure each cell has clear boundaries and labels are in their own cells (not merged with value cells)
5. Remove any form fields: go to **Developer → Design Mode**, select all form fields, and delete them
6. Save as PDF using **File → Save As → PDF**

## Common Issues and Fixes

**Date value appears inside the label cell instead of the value cell**: This happens when the table has merged or unusually wide label cells. Make sure "Date:" is in its own narrow column and the value area is a separate column to the right.

**Photos appear on page 3 instead of page 2**: Your template has a blank continuation page (usually titled "Additional Documentation and Photos as Needed"). Delete this page — the app automatically creates properly formatted photo pages after your report content.

**Fields not detected correctly**: Make sure field labels end with a colon (like "Date:", "Weather:", "Daily Notes:") and are in bold text. This helps the AI identify them as fillable fields.

**Report looks different from the original**: Avoid using custom or decorative fonts in your template. Stick to standard fonts like Arial, Helvetica, Times New Roman, or Calibri. The app uses Helvetica for filled-in values.

## Template Best Practices

- Keep it to 1 page for the main report content
- Use a clear table layout with labels in the left column and value areas in the right column
- Bold all field labels (Date:, Weather:, Daily Notes:, etc.)
- Use standard fonts (Arial, Helvetica, Times New Roman)
- Don't include blank "overflow" pages — the app handles additional pages for photos
- Save as PDF with "Standard" quality (not "Minimum size" which can lose text positioning data)
