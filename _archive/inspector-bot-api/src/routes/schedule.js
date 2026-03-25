/**
 * Schedule Routes
 * Import schedules, analyze for inspections, manage tracking preferences
 */
import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../utils/supabase.js';
import { importSchedule, analyzeForInspections, updateTrackingPreferences } from '../services/schedule.js';

export const scheduleRoutes = Router();

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Schedule must be .xlsx, .xls, or .csv'));
    }
  }
});

// Upload and import a construction schedule
scheduleRoutes.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const result = await importSchedule(req.file, projectId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Analyze schedule for required inspections
scheduleRoutes.post('/analyze', async (req, res) => {
  try {
    const { projectId, userId } = req.body;
    if (!projectId || !userId) {
      return res.status(400).json({ success: false, error: 'projectId and userId are required' });
    }

    const result = await analyzeForInspections(projectId, userId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get schedule items for a project
scheduleRoutes.get('/project/:projectId', async (req, res) => {
  try {
    const { trade, status, tracked } = req.query;

    let query = supabase
      .from('schedule_items')
      .select('*')
      .eq('project_id', req.params.projectId)
      .order('start_date', { ascending: true });

    if (trade) query = query.eq('trade', trade);
    if (status) query = query.eq('status', status);
    if (tracked !== undefined) query = query.eq('tracked', tracked === 'true');

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, items: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update tracking preferences (what inspector wants to see)
scheduleRoutes.patch('/tracking', async (req, res) => {
  try {
    const { projectId, preferences } = req.body;
    if (!projectId || !preferences) {
      return res.status(400).json({ success: false, error: 'projectId and preferences are required' });
    }

    const result = await updateTrackingPreferences(projectId, preferences);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update a single schedule item
scheduleRoutes.patch('/:id', async (req, res) => {
  try {
    const allowed = ['status', 'actual_start', 'actual_finish', 'percent_complete', 'tracked', 'notes', 'location', 'grid_lines', 'floor_level'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('schedule_items')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
