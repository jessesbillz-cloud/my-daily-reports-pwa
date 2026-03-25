/**
 * Document Routes
 * Upload, ingest, list, manage project documents
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { supabase } from '../utils/supabase.js';
import { ingestDocument } from '../services/ingestion.js';

export const documentRoutes = Router();

// Multer config for file uploads
const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.jpg', '.jpeg', '.png', '.heic'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Allowed: ${allowed.join(', ')}`));
    }
  }
});

// Upload and ingest a document
documentRoutes.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { projectId, userId, docCategory, documentNumber, title, description } = req.body;

    if (!projectId || !userId || !docCategory) {
      return res.status(400).json({
        success: false,
        error: 'projectId, userId, and docCategory are required'
      });
    }

    const result = await ingestDocument(req.file, {
      projectId,
      userId,
      docCategory,
      documentNumber,
      title,
      description
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk upload multiple documents
documentRoutes.post('/upload-bulk', upload.array('files', 50), async (req, res) => {
  try {
    const { projectId, userId } = req.body;
    // docCategories and titles can be JSON arrays matching file order
    const categories = JSON.parse(req.body.docCategories || '[]');
    const titles = JSON.parse(req.body.titles || '[]');
    const numbers = JSON.parse(req.body.documentNumbers || '[]');

    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      try {
        const result = await ingestDocument(req.files[i], {
          projectId,
          userId,
          docCategory: categories[i] || 'other',
          documentNumber: numbers[i] || null,
          title: titles[i] || req.files[i].originalname
        });
        results.push({ file: req.files[i].originalname, ...result });
      } catch (err) {
        results.push({ file: req.files[i].originalname, success: false, error: err.message });
      }
    }

    res.json({
      success: true,
      total: req.files.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List documents for a project
documentRoutes.get('/project/:projectId', async (req, res) => {
  try {
    const { category, status } = req.query;

    let query = supabase
      .from('project_documents')
      .select('id, filename, original_filename, file_type, doc_category, document_number, title, description, page_count, processing_status, processing_error, created_at')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: false });

    if (category) query = query.eq('doc_category', category);
    if (status) query = query.eq('processing_status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, documents: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get document details with chunk info
documentRoutes.get('/:id', async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from('project_documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // Get chunk count
    const { count } = await supabase
      .from('document_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('document_id', req.params.id);

    res.json({
      success: true,
      document: doc,
      chunkCount: count || 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-process a failed document
documentRoutes.post('/:id/reprocess', async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('project_documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    // Delete existing chunks and embeddings
    await supabase.from('document_embeddings')
      .delete()
      .in('chunk_id',
        (await supabase.from('document_chunks').select('id').eq('document_id', doc.id)).data?.map(c => c.id) || []
      );
    await supabase.from('document_chunks').delete().eq('document_id', doc.id);

    // Download from storage and re-process
    const { data: fileData } = await supabase.storage
      .from('project-documents')
      .download(doc.storage_path);

    if (!fileData) throw new Error('File not found in storage');

    // Save to temp and re-ingest
    const fs = await import('fs/promises');
    const tmpPath = `/tmp/uploads/reprocess_${doc.id}_${doc.filename}`;
    const buffer = Buffer.from(await fileData.arrayBuffer());
    await fs.writeFile(tmpPath, buffer);

    const result = await ingestDocument(
      { path: tmpPath, originalname: doc.original_filename, size: doc.file_size_bytes, filename: doc.filename, mimetype: 'application/octet-stream' },
      {
        projectId: doc.project_id,
        userId: doc.user_id,
        docCategory: doc.doc_category,
        documentNumber: doc.document_number,
        title: doc.title
      }
    );

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a document (and its chunks/embeddings)
documentRoutes.delete('/:id', async (req, res) => {
  try {
    // Cascading delete handles chunks → embeddings
    const { error } = await supabase
      .from('project_documents')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
