/**
 * RAG (Retrieval-Augmented Generation) Service
 * Handles: query → embed → search → context assembly → LLM → response
 */
import { supabase } from '../utils/supabase.js';
import { generateEmbedding, queryLLM, classifyQuery } from '../utils/ai.js';
import { config } from '../../config/index.js';
import crypto from 'crypto';

/**
 * Main query pipeline
 * 1. Check cache
 * 2. Classify query complexity
 * 3. Generate query embedding
 * 4. Semantic search for relevant chunks
 * 5. Assemble context
 * 6. Query Claude with context
 * 7. Cache and return
 */
export async function queryProject(projectId, query, options = {}) {
  const {
    userId,
    conversationId,
    channel = 'web',
    filterCategory = null,
    filterSpecSection = null,
    skipCache = false
  } = options;

  // 1. Check cache first
  if (!skipCache) {
    const cached = await checkCache(projectId, query);
    if (cached) {
      // Update hit count
      await supabase
        .from('query_cache')
        .update({ hit_count: cached.hit_count + 1 })
        .eq('id', cached.id);

      return {
        content: cached.response,
        citations: cached.citations,
        cached: true,
        model: cached.model
      };
    }
  }

  // 2. Get project info for context
  const { data: project } = await supabase
    .from('projects')
    .select('name, project_number, is_dsa')
    .eq('id', projectId)
    .single();

  // 3. Classify query to pick the right AI tier
  const model = await classifyQuery(query);

  // 4. Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query);

  // 5. Semantic search
  const { data: matches, error: searchErr } = await supabase
    .rpc('match_documents', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_project_id: projectId,
      match_threshold: config.RAG_MATCH_THRESHOLD,
      match_count: config.RAG_MATCH_COUNT,
      filter_category: filterCategory,
      filter_spec_section: filterSpecSection
    });

  if (searchErr) {
    console.error('Semantic search error:', searchErr);
    throw new Error('Failed to search project documents');
  }

  if (!matches || matches.length === 0) {
    return {
      content: "I couldn't find any relevant information in your project documents for that question. Make sure the relevant specs, plans, RFIs, or submittals have been uploaded.",
      citations: [],
      cached: false,
      model: null
    };
  }

  // 6. Enrich context with related RFIs and submittals
  const enrichedMatches = await enrichWithRelatedDocs(projectId, matches);

  // 7. Query Claude with assembled context
  const response = await queryLLM(query, enrichedMatches, {
    model,
    projectName: project?.name || 'Unknown Project'
  });

  // 8. Build citations
  const citations = enrichedMatches.map(m => ({
    chunk_id: m.chunk_id,
    document_id: m.document_id,
    document_title: m.document_title || m.original_filename,
    doc_category: m.doc_category,
    page_number: m.page_number,
    spec_section: m.spec_section,
    plan_sheet: m.plan_sheet,
    reference_number: m.reference_number,
    similarity: m.similarity,
    snippet: m.content?.substring(0, 200) + '...'
  }));

  // 9. Store in conversation if provided
  if (conversationId) {
    await storeMessages(conversationId, query, response, citations);
  }

  // 10. Cache the response
  await cacheResponse(projectId, query, response.content, citations, model);

  return {
    content: response.content,
    citations,
    cached: false,
    model: response.model,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    responseTime: response.responseTime
  };
}

/**
 * Enrich search results with related RFIs and submittals
 * If a match references spec section "22 40 00", find all RFIs and submittals for that section
 */
async function enrichWithRelatedDocs(projectId, matches) {
  const specSections = [...new Set(matches.map(m => m.spec_section).filter(Boolean))];

  if (specSections.length === 0) return matches;

  // Find related RFIs
  for (const section of specSections) {
    const { data: rfis } = await supabase
      .rpc('find_related_rfis', {
        p_project_id: projectId,
        p_spec_section: section
      });

    if (rfis?.length > 0) {
      // Get the chunks from these RFIs to add to context
      for (const rfi of rfis) {
        const { data: rfiChunks } = await supabase
          .from('document_chunks')
          .select('*')
          .eq('document_id', rfi.document_id)
          .limit(3);

        if (rfiChunks) {
          for (const chunk of rfiChunks) {
            // Add if not already in matches
            if (!matches.find(m => m.chunk_id === chunk.id)) {
              matches.push({
                ...chunk,
                chunk_id: chunk.id,
                doc_category: 'rfi',
                document_title: rfi.title,
                reference_number: rfi.document_number,
                similarity: 0.8 // Related, not direct match
              });
            }
          }
        }
      }
    }

    // Find related submittals
    const { data: submittals } = await supabase
      .rpc('find_related_submittals', {
        p_project_id: projectId,
        p_spec_section: section
      });

    if (submittals?.length > 0) {
      for (const sub of submittals) {
        const { data: subChunks } = await supabase
          .from('document_chunks')
          .select('*')
          .eq('document_id', sub.document_id)
          .limit(3);

        if (subChunks) {
          for (const chunk of subChunks) {
            if (!matches.find(m => m.chunk_id === chunk.id)) {
              matches.push({
                ...chunk,
                chunk_id: chunk.id,
                doc_category: 'submittal',
                document_title: sub.title,
                reference_number: sub.document_number,
                similarity: 0.8
              });
            }
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Check query cache
 */
async function checkCache(projectId, query) {
  const queryHash = crypto.createHash('sha256')
    .update(query.toLowerCase().trim())
    .digest('hex');

  const { data } = await supabase
    .from('query_cache')
    .select('*')
    .eq('project_id', projectId)
    .eq('query_hash', queryHash)
    .eq('valid', true)
    .gt('expires_at', new Date().toISOString())
    .single();

  return data;
}

/**
 * Cache a response
 */
async function cacheResponse(projectId, query, response, citations, model) {
  const queryHash = crypto.createHash('sha256')
    .update(query.toLowerCase().trim())
    .digest('hex');

  await supabase
    .from('query_cache')
    .upsert({
      project_id: projectId,
      query_hash: queryHash,
      query_text: query,
      response,
      citations,
      model,
      valid: true,
      hit_count: 0,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }, {
      onConflict: 'project_id,query_hash'
    });
}

/**
 * Store messages in conversation history
 */
async function storeMessages(conversationId, query, response, citations) {
  // Store user message
  await supabase
    .from('bot_messages')
    .insert({
      conversation_id: conversationId,
      role: 'user',
      content: query
    });

  // Store assistant response
  await supabase
    .from('bot_messages')
    .insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: response.content,
      citations,
      model: response.model,
      prompt_tokens: response.promptTokens,
      completion_tokens: response.completionTokens,
      response_time_ms: response.responseTime
    });
}
