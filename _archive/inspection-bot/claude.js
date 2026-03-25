const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Parse WhatsApp message using Claude
 */
async function parseMessage(messageText) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are parsing WhatsApp messages from a construction inspector. Extract the project name and notes.

Projects: Oceanside, Hunter Hall, Woodland Park

Message: "${messageText}"

Respond with JSON only (no markdown):
{
  "project": "project name or null",
  "notes": "inspection notes with bullet points"
}

Rules:
- Project names can be partial matches (e.g., "Hunter" → "Hunter Hall")
- Format notes with bullet points (•) 
- Each note on new line
- If no clear project, set project to null`
      }]
    });
    
    const text = response.content[0].text.trim();
    
    // Remove markdown code fences if present
    const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
    
    const parsed = JSON.parse(cleanJson);
    
    return {
      project: parsed.project,
      notes: parsed.notes
    };
    
  } catch (error) {
    console.error('Error parsing with Claude:', error);
    throw error;
  }
}

module.exports = {
  parseMessage
};
