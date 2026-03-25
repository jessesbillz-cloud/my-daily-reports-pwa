/**
 * Document Ingestion Service
 * Handles: upload → parse (via OpenDataLoader) → chunk → embed → store
 */
import { supabase } from '../utils/supabase.js';
import { generateEmbeddings } from '../utils/ai.js';
import { config } from '../../config/index.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Process an uploaded document end-to-end
 * 1. Upload file to Supabase storage
 * 2. Send to OpenDataLoader for parsing
 * 3. Chunk the parsed content
 * 4. Generate embeddings
 * 5. Store everything in the database
 */
export async function ingestDocument(file, metadata) {
  const { projectId, userId, docCategory, documentNumber, title, description } = metadata;
  let docRecord = null;

  try {
    // 1. Create document record (status: pending)
    const { data: doc, error: docErr } = await supabase
      .from('project_documents')
      .insert({
        project_id: projectId,
        user_id: userId,
        filename: file.filename,
        original_filename: file.originalname,
        file_type: getFileType(file.originalname),
        doc_category: docCategory,
        document_number: documentNumber || null,
        title: title || file.originalname,
        description: description || null,
        storage_path: '', // Will update after upload
        file_size_bytes: file.size,
        processing_status: 'pending'
      })
      .select()
      .single();

    if (docErr) throw new Error(`Failed to create document record: ${docErr.message}`);
    docRecord = doc;

    // 2. Upload to Supabase Storage
    await updateStatus(doc.id, 'parsing');
    const storagePath = `${projectId}/${doc.id}/${file.originalname}`;
    const fileBuffer = await fs.readFile(file.path);

    const { error: uploadErr } = await supabase.storage
      .from('project-documents')
      .upload(storagePath, fileBuffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    await supabase
      .from('project_documents')
      .update({ storage_path: storagePath })
      .eq('id', doc.id);

    // 3. Parse via OpenDataLoader
    const parsed = await parseWithOpenDataLoader(file.path);

    // Update page count
    const pageCount = parsed.pages?.length || parsed.data?.pages?.length || 0;
    await supabase
      .from('project_documents')
      .update({
        page_count: pageCount,
        extracted_metadata: { raw_structure: summarizeParsed(parsed) }
      })
      .eq('id', doc.id);

    // 4. Chunk the parsed content
    await updateStatus(doc.id, 'chunking');
    const chunks = chunkDocument(parsed, {
      docId: doc.id,
      projectId,
      docCategory,
      documentNumber,
      chunkSize: config.CHUNK_SIZE,
      chunkOverlap: config.CHUNK_OVERLAP
    });

    if (chunks.length === 0) {
      throw new Error('No content could be extracted from the document');
    }

    // 5. Store chunks
    const { data: storedChunks, error: chunkErr } = await supabase
      .from('document_chunks')
      .insert(chunks)
      .select('id, content');

    if (chunkErr) throw new Error(`Failed to store chunks: ${chunkErr.message}`);

    // 6. Generate embeddings (batch)
    await updateStatus(doc.id, 'embedding');
    const chunkTexts = storedChunks.map(c => c.content);

    // Process in batches of 100 (OpenAI limit)
    const BATCH_SIZE = 100;
    const allEmbeddings = [];

    for (let i = 0; i < chunkTexts.length; i += BATCH_SIZE) {
      const batch = chunkTexts.slice(i, i + BATCH_SIZE);
      const embeddings = await generateEmbeddings(batch);
      allEmbeddings.push(...embeddings);
    }

    // 7. Store embeddings
    const embeddingRows = storedChunks.map((chunk, i) => ({
      chunk_id: chunk.id,
      project_id: projectId,
      embedding: JSON.stringify(allEmbeddings[i]),
      model: config.EMBEDDING_MODEL
    }));

    const { error: embedErr } = await supabase
      .from('document_embeddings')
      .insert(embeddingRows);

    if (embedErr) throw new Error(`Failed to store embeddings: ${embedErr.message}`);

    // 8. Mark as ready
    await updateStatus(doc.id, 'ready');

    return {
      success: true,
      documentId: doc.id,
      chunks: storedChunks.length,
      pages: pageCount
    };

  } catch (error) {
    console.error('Ingestion error:', error);
    if (docRecord) {
      await supabase
        .from('project_documents')
        .update({
          processing_status: 'failed',
          processing_error: error.message
        })
        .eq('id', docRecord.id);
    }
    throw error;
  }
}

/**
 * Send file to OpenDataLoader microservice for parsing
 */
async function parseWithOpenDataLoader(filePath) {
  const FormData = (await import('node-fetch')).default ? null : null;
  // Use native fetch (Node 20+)
  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  const formData = new globalThis.FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);

  const response = await fetch(`${config.OPENDATALOADER_URL}/parse`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenDataLoader failed (${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * Chunk parsed document content into smaller pieces for embedding
 */
function chunkDocument(parsed, options) {
  const { docId, projectId, docCategory, documentNumber, chunkSize, chunkOverlap } = options;
  const chunks = [];
  let chunkIndex = 0;

  // Extract text from parsed data (handles both ODL formats)
  const pages = parsed.pages || parsed.data?.pages || [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    const pageNumber = pageIdx + 1;

    // Collect all text from the page
    let pageText = '';

    if (page.text) {
      // Simple text array
      if (Array.isArray(page.text)) {
        pageText = page.text.map(t => typeof t === 'string' ? t : t.value || t.text || '').join(' ');
      } else {
        pageText = String(page.text);
      }
    }

    // Also extract table content
    if (page.tables) {
      for (const table of page.tables) {
        if (table.cells) {
          const cellTexts = table.cells
            .map(c => c.value || c.text || '')
            .filter(Boolean);
          pageText += ' ' + cellTexts.join(' | ');
        }
      }
    }

    if (!pageText.trim()) continue;

    // Split into chunks by approximate token count (1 token ≈ 4 chars)
    const words = pageText.split(/\s+/);
    const wordsPerChunk = Math.floor(chunkSize * 4 / 5); // avg 5 chars per word
    const overlapWords = Math.floor(chunkOverlap * 4 / 5);

    for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
      const chunkWords = words.slice(i, i + wordsPerChunk);
      if (chunkWords.length < 10) continue; // Skip tiny fragments

      const content = chunkWords.join(' ');
      const tokenCount = Math.ceil(content.length / 4);

      // Try to detect spec section from content
      const specSection = detectSpecSection(content);
      const planSheet = detectPlanSheet(content);

      chunks.push({
        document_id: docId,
        project_id: projectId,
        content,
        page_number: pageNumber,
        section_title: detectSectionTitle(content),
        spec_section: specSection,
        plan_sheet: planSheet,
        reference_number: documentNumber || null,
        chunk_index: chunkIndex++,
        token_count: tokenCount,
        metadata: { doc_category: docCategory }
      });
    }
  }

  return chunks;
}

/**
 * Detect CSI spec section numbers (e.g., "22 40 00", "Division 22")
 */
function detectSpecSection(text) {
  // Match patterns like "22 40 00" or "Section 22 40 00" or "Division 22"
  const patterns = [
    /(?:Section\s+)?(\d{2}\s+\d{2}\s+\d{2})/i,
    /Division\s+(\d{1,2})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Detect plan sheet references (e.g., "P2.1", "S3.2", "A1.1")
 */
function detectPlanSheet(text) {
  const match = text.match(/\b([ASPEMLFC]\d+\.\d+[A-Za-z]?)\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Detect section titles from text
 */
function detectSectionTitle(text) {
  // Look for capitalized headers or numbered sections
  const lines = text.split(/[.\n]/);
  for (const line of lines.slice(0, 3)) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && trimmed.length < 100) {
      if (/^[A-Z\d]/.test(trimmed) && !/^[a-z]/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * Create a compact summary of parsed structure (for metadata)
 */
function summarizeParsed(parsed) {
  const pages = parsed.pages || parsed.data?.pages || [];
  return {
    page_count: pages.length,
    has_tables: pages.some(p => p.tables?.length > 0),
    has_text: pages.some(p => p.text?.length > 0)
  };
}

/**
 * Update document processing status
 */
async function updateStatus(docId, status) {
  await supabase
    .from('project_documents')
    .update({ processing_status: status })
    .eq('id', docId);
}

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const typeMap = {
    pdf: 'pdf', docx: 'docx', doc: 'doc',
    xlsx: 'xlsx', xls: 'xls', csv: 'csv',
    jpg: 'jpg', jpeg: 'jpg', png: 'png', heic: 'heic'
  };
  return typeMap[ext] || 'pdf';
}
