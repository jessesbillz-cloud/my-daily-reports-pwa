import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../../config/index.js';

// Anthropic client (Claude for reasoning)
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// OpenAI client (for embeddings only)
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

/**
 * Generate embeddings for text using OpenAI
 * text-embedding-3-small: $0.02/1M tokens, 1536 dimensions
 */
export async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input: text,
    dimensions: config.EMBEDDING_DIMENSIONS
  });
  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts in batch
 */
export async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input: texts,
    dimensions: config.EMBEDDING_DIMENSIONS
  });
  return response.data.map(d => d.embedding);
}

/**
 * Query Claude with context (RAG)
 * @param {string} query - User's question
 * @param {Array} context - Relevant document chunks
 * @param {Object} options - { model, systemPrompt, maxTokens }
 */
export async function queryLLM(query, context = [], options = {}) {
  const {
    model = config.AI_TIER_2,
    systemPrompt = null,
    maxTokens = 2048,
    projectName = 'this project'
  } = options;

  const defaultSystem = `You are Inspector Bot, an AI construction inspection assistant. You help inspectors with document lookups, code compliance, inspection preparation, and field questions.

CRITICAL RULES:
1. ONLY answer based on the provided project documents. If information isn't in the documents, say so.
2. ALWAYS cite your sources: document name, page number, section, RFI/submittal number.
3. If an RFI modifies the original spec, the RFI takes precedence. Always check for relevant RFIs.
4. Be specific: include exact product names, model numbers, dimensions, and code references.
5. If you're not sure, say "I'd recommend verifying this in the field" rather than guessing.
6. Keep answers concise and actionable for a field inspector.

You are working on project: ${projectName}`;

  const contextText = context.map((chunk, i) => {
    const source = [
      chunk.document_title || chunk.original_filename,
      chunk.doc_category ? `[${chunk.doc_category.toUpperCase()}]` : '',
      chunk.reference_number ? `#${chunk.reference_number}` : '',
      chunk.page_number ? `Page ${chunk.page_number}` : '',
      chunk.spec_section ? `Section ${chunk.spec_section}` : '',
      chunk.plan_sheet ? `Sheet ${chunk.plan_sheet}` : '',
    ].filter(Boolean).join(' | ');

    return `--- Source ${i + 1}: ${source} ---\n${chunk.content}`;
  }).join('\n\n');

  const userMessage = context.length > 0
    ? `Here are the relevant project documents:\n\n${contextText}\n\n---\n\nQuestion: ${query}`
    : query;

  const startTime = Date.now();

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt || defaultSystem,
    messages: [{ role: 'user', content: userMessage }]
  });

  const responseTime = Date.now() - startTime;

  return {
    content: response.content[0].text,
    model: response.model,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    responseTime
  };
}

/**
 * Classify a query to determine which tier of AI to use
 * Simple lookups → Haiku, Complex reasoning → Sonnet, Novel interpretation → Opus
 */
export async function classifyQuery(query) {
  const response = await anthropic.messages.create({
    model: config.AI_TIER_1, // Use Haiku for classification (cheap)
    max_tokens: 100,
    system: `Classify this construction inspection query into one of these categories:
- LOOKUP: Simple fact lookup (product name, spec section, plan sheet reference)
- ANALYSIS: Requires cross-referencing multiple documents or reasoning
- COMPLEX: Novel code interpretation, conflicting information resolution
Respond with ONLY the category name.`,
    messages: [{ role: 'user', content: query }]
  });

  const category = response.content[0].text.trim().toUpperCase();

  switch (category) {
    case 'LOOKUP': return config.AI_TIER_1;
    case 'COMPLEX': return config.AI_TIER_3;
    default: return config.AI_TIER_2;
  }
}

/**
 * Analyze a photo from the field
 */
export async function analyzePhoto(imageBase64, context = '') {
  const response = await anthropic.messages.create({
    model: config.AI_TIER_2,
    max_tokens: 1024,
    system: `You are a construction inspection photo analyzer. Identify:
1. What construction element/system is shown
2. Any visible product names, model numbers, labels
3. Any potential issues or deficiencies
4. The approximate location context (floor, area)
Be specific and technical. This will be used for inspection documentation.`,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageBase64
          }
        },
        {
          type: 'text',
          text: context || 'Analyze this construction inspection photo. What do you see?'
        }
      ]
    }]
  });

  return {
    description: response.content[0].text,
    model: response.model,
    tokens: response.usage.input_tokens + response.usage.output_tokens
  };
}

/**
 * Parse a construction schedule activity to identify inspection requirements
 */
export async function analyzeScheduleForInspections(activities, projectContext = '') {
  const response = await anthropic.messages.create({
    model: config.AI_TIER_2,
    max_tokens: 4096,
    system: `You are a construction inspection scheduling expert specializing in DSA (Division of the State Architect) projects in California.

Given a list of construction schedule activities, identify which ones require or may trigger inspections.

For each activity that needs inspection, provide:
1. inspection_type: The type of inspection needed
2. trade: The trade/discipline (plumbing, electrical, structural, etc.)
3. csi_division: The CSI division number (e.g., "22" for plumbing)
4. checklist_items: Key items an inspector should check
5. relevant_codes: Applicable building codes (CBC, CPC, CEC, CMC, CFC)
6. timing: When the inspection should occur relative to the activity (before, during, after)

Respond in JSON format as an array of objects.`,
    messages: [{
      role: 'user',
      content: `Project context: ${projectContext}\n\nSchedule activities:\n${JSON.stringify(activities, null, 2)}`
    }]
  });

  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    let text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse schedule analysis:', e);
    return [];
  }
}

/**
 * Generate a QA/QC checklist from spec sections and related docs
 */
export async function generateChecklist(inspectionType, specContent, rfis = [], submittals = []) {
  const response = await anthropic.messages.create({
    model: config.AI_TIER_2,
    max_tokens: 4096,
    system: `You are a construction QA/QC checklist generator. Given spec sections, RFIs, and submittals, create a detailed inspection checklist.

For each checklist item, provide:
1. item: What to check (be specific - include product names, dimensions, codes)
2. spec_ref: The spec section reference
3. plan_ref: Plan sheet reference if applicable
4. rfi_ref: RFI number if this item was modified by an RFI
5. submittal_ref: Submittal number for approved product
6. code_ref: Building code reference
7. required: true/false - is this a mandatory inspection point
8. notes: Any special notes (e.g., "Changed from Zurn 750 to Zurn 700 per RFI 225")

Respond in JSON format as an array of checklist items.`,
    messages: [{
      role: 'user',
      content: `Inspection type: ${inspectionType}

Spec content:
${specContent}

${rfis.length ? `Related RFIs:\n${rfis.map(r => `RFI ${r.number}: ${r.content}`).join('\n\n')}` : 'No related RFIs.'}

${submittals.length ? `Related Submittals:\n${submittals.map(s => `Submittal ${s.number}: ${s.content}`).join('\n\n')}` : 'No related submittals.'}`
    }]
  });

  try {
    let text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse checklist:', e);
    return [];
  }
}

/**
 * Generate daily report text from inspection results
 */
export async function generateDailyReportText(inspection, checklistResults, photos = []) {
  const response = await anthropic.messages.create({
    model: config.AI_TIER_1, // Haiku is fine for this
    max_tokens: 1024,
    system: `You are writing a daily inspection report entry. Be professional, concise, and factual.
Include: what was inspected, the result (pass/fail/conditional), any specific findings,
product verifications, and references to relevant documents (RFIs, submittals, plan sheets).
Write in third-person past tense as if the inspector is documenting their work.`,
    messages: [{
      role: 'user',
      content: `Inspection: ${inspection.title}
Type: ${inspection.inspection_type}
Location: ${inspection.location || 'N/A'}
Result: ${inspection.result || 'pending'}
Notes: ${inspection.result_notes || 'None'}

Checklist results:
${JSON.stringify(checklistResults, null, 2)}

${photos.length ? `Photos taken: ${photos.length} (${photos.map(p => p.ai_description).join('; ')})` : 'No photos.'}`
    }]
  });

  return response.content[0].text;
}
