/**
 * Photo Routes
 * Upload field photos, AI analysis, link to inspections
 */
import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../utils/supabase.js';
import { analyzePhoto } from '../utils/ai.js';
import fs from 'fs/promises';

export const photoRoutes = Router();

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per photo
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.match(/\.(jpg|jpeg|png|heic|heif)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Upload and analyze a photo
photoRoutes.post('/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No photo uploaded' });
    }

    const { projectId, userId, inspectionId, location, gridLine, floorLevel, context } = req.body;

    if (!projectId || !userId) {
      return res.status(400).json({ success: false, error: 'projectId and userId are required' });
    }

    // Upload to Supabase storage
    const fileBuffer = await fs.readFile(req.file.path);
    const storagePath = `${projectId}/photos/${Date.now()}_${req.file.originalname}`;

    const { error: uploadErr } = await supabase.storage
      .from('project-documents')
      .upload(storagePath, fileBuffer, {
        contentType: req.file.mimetype
      });

    if (uploadErr) throw new Error(`Photo upload failed: ${uploadErr.message}`);

    // AI analysis
    const base64 = fileBuffer.toString('base64');
    const analysis = await analyzePhoto(base64, context || `Construction inspection photo at ${location || 'project site'}`);

    // Extract tags from description
    const tags = extractTags(analysis.description);

    // Store photo record
    const { data: photo, error } = await supabase
      .from('inspection_photos')
      .insert({
        project_id: projectId,
        user_id: userId,
        inspection_id: inspectionId || null,
        storage_path: storagePath,
        ai_description: analysis.description,
        ai_tags: tags,
        identified_items: [],
        location: location || null,
        grid_line: gridLine || null,
        floor_level: floorLevel || null
      })
      .select()
      .single();

    if (error) throw error;

    // Cleanup temp file
    await fs.unlink(req.file.path).catch(() => {});

    res.json({
      success: true,
      photo,
      analysis: analysis.description
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload multiple photos at once
photoRoutes.post('/upload-batch', upload.array('photos', 20), async (req, res) => {
  try {
    const { projectId, userId, inspectionId } = req.body;
    const results = [];

    for (const file of req.files) {
      try {
        const fileBuffer = await fs.readFile(file.path);
        const storagePath = `${projectId}/photos/${Date.now()}_${file.originalname}`;

        await supabase.storage
          .from('project-documents')
          .upload(storagePath, fileBuffer, { contentType: file.mimetype });

        const base64 = fileBuffer.toString('base64');
        const analysis = await analyzePhoto(base64);

        const { data: photo } = await supabase
          .from('inspection_photos')
          .insert({
            project_id: projectId,
            user_id: userId,
            inspection_id: inspectionId || null,
            storage_path: storagePath,
            ai_description: analysis.description,
            ai_tags: extractTags(analysis.description)
          })
          .select()
          .single();

        results.push({ file: file.originalname, success: true, photo });
        await fs.unlink(file.path).catch(() => {});
      } catch (err) {
        results.push({ file: file.originalname, success: false, error: err.message });
      }
    }

    res.json({
      success: true,
      total: req.files.length,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get photos for a project/inspection
photoRoutes.get('/project/:projectId', async (req, res) => {
  try {
    const { inspectionId } = req.query;

    let query = supabase
      .from('inspection_photos')
      .select('*')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: false });

    if (inspectionId) query = query.eq('inspection_id', inspectionId);

    const { data, error } = await query;
    if (error) throw error;

    // Generate signed URLs
    const photos = await Promise.all((data || []).map(async (photo) => {
      const { data: urlData } = await supabase.storage
        .from('project-documents')
        .createSignedUrl(photo.storage_path, 3600);
      return { ...photo, url: urlData?.signedUrl };
    }));

    res.json({ success: true, photos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ask a question about a photo
photoRoutes.post('/:id/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    const { data: photo } = await supabase
      .from('inspection_photos')
      .select('storage_path, project_id')
      .eq('id', req.params.id)
      .single();

    if (!photo) return res.status(404).json({ success: false, error: 'Photo not found' });

    // Download and analyze
    const { data: fileData } = await supabase.storage
      .from('project-documents')
      .download(photo.storage_path);

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const base64 = buffer.toString('base64');

    const analysis = await analyzePhoto(base64, question);

    res.json({
      success: true,
      answer: analysis.description
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Extract relevant tags from AI description
 */
function extractTags(description) {
  const tagKeywords = [
    'plumbing', 'electrical', 'structural', 'mechanical', 'hvac',
    'fire', 'sprinkler', 'concrete', 'steel', 'rebar', 'anchor',
    'pipe', 'conduit', 'duct', 'insulation', 'waterproofing',
    'framing', 'drywall', 'ceiling', 'floor', 'roof', 'wall',
    'door', 'window', 'glazing', 'tile', 'paint', 'fixture',
    'panel', 'switch', 'outlet', 'light', 'drain', 'valve',
    'deficiency', 'damage', 'crack', 'leak', 'corrosion',
    'label', 'tag', 'sticker', 'nameplate'
  ];

  const lower = description.toLowerCase();
  return tagKeywords.filter(tag => lower.includes(tag));
}
