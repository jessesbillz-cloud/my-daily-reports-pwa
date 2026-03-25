/**
 * Query Routes
 * The main chat/Q&A interface - "Hey Inspector Bot, what anchor is used..."
 */
import { Router } from 'express';
import { supabase } from '../utils/supabase.js';
import { queryProject } from '../services/rag.js';

export const queryRoutes = Router();

// Ask a question about a project
queryRoutes.post('/', async (req, res) => {
  try {
    const { projectId, userId, query, conversationId, filterCategory, filterSpecSection } = req.body;

    if (!projectId || !query) {
      return res.status(400).json({ success: false, error: 'projectId and query are required' });
    }

    // Create or get conversation
    let convId = conversationId;
    if (!convId && userId) {
      const { data: conv } = await supabase
        .from('bot_conversations')
        .insert({
          user_id: userId,
          project_id: projectId,
          channel: 'web'
        })
        .select()
        .single();
      convId = conv?.id;
    }

    const result = await queryProject(projectId, query, {
      userId,
      conversationId: convId,
      filterCategory,
      filterSpecSection
    });

    res.json({
      success: true,
      answer: result.content,
      citations: result.citations,
      cached: result.cached,
      model: result.model,
      conversationId: convId,
      usage: result.promptTokens ? {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        responseTime: result.responseTime
      } : undefined
    });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get conversation history
queryRoutes.get('/conversations/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bot_conversations')
      .select(`
        id, project_id, channel, created_at, updated_at,
        projects(name)
      `)
      .eq('user_id', req.params.userId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json({ success: true, conversations: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get messages in a conversation
queryRoutes.get('/conversations/:conversationId/messages', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const { data, error } = await supabase
      .from('bot_messages')
      .select('*')
      .eq('conversation_id', req.params.conversationId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ success: true, messages: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick search - find a specific document reference
// "Find me that detail" / "Send me a link to RFI 225"
queryRoutes.get('/find', async (req, res) => {
  try {
    const { projectId, type, number, query: searchText } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    // If looking for a specific document by number
    if (type && number) {
      const { data } = await supabase
        .from('project_documents')
        .select('*')
        .eq('project_id', projectId)
        .eq('doc_category', type)
        .eq('document_number', number)
        .single();

      if (data) {
        // Get download URL
        const { data: urlData } = await supabase.storage
          .from('project-documents')
          .createSignedUrl(data.storage_path, 3600); // 1 hour

        return res.json({
          success: true,
          document: data,
          downloadUrl: urlData?.signedUrl
        });
      }

      return res.status(404).json({ success: false, error: `${type.toUpperCase()} ${number} not found` });
    }

    // Free text search across document titles and content
    if (searchText) {
      const { data: docs } = await supabase
        .from('project_documents')
        .select('id, title, original_filename, doc_category, document_number, storage_path')
        .eq('project_id', projectId)
        .or(`title.ilike.%${searchText}%,original_filename.ilike.%${searchText}%,document_number.ilike.%${searchText}%`);

      // Generate signed URLs
      const results = await Promise.all((docs || []).map(async (doc) => {
        const { data: urlData } = await supabase.storage
          .from('project-documents')
          .createSignedUrl(doc.storage_path, 3600);
        return { ...doc, downloadUrl: urlData?.signedUrl };
      }));

      return res.json({ success: true, documents: results });
    }

    res.status(400).json({ success: false, error: 'Provide type+number or query parameter' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
