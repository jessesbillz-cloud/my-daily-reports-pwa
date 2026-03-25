/**
 * Inspection Routes
 * Manage inspections, prep packages, checklists, results
 */
import { Router } from 'express';
import { supabase } from '../utils/supabase.js';
import {
  prepareInspection,
  generateInspectionChecklist,
  recordInspectionResult,
  getInspectionHistory
} from '../services/inspections.js';
import { getUpcomingInspections } from '../services/schedule.js';

export const inspectionRoutes = Router();

// Get upcoming inspections for a project
inspectionRoutes.get('/upcoming/:projectId', async (req, res) => {
  try {
    const daysAhead = parseInt(req.query.days) || 7;
    const inspections = await getUpcomingInspections(req.params.projectId, daysAhead);
    res.json({ success: true, inspections });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get inspection history
inspectionRoutes.get('/history/:projectId', async (req, res) => {
  try {
    const { status, trade, dateFrom, dateTo } = req.query;
    const history = await getInspectionHistory(req.params.projectId, {
      status, trade, dateFrom, dateTo
    });
    res.json({ success: true, inspections: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single inspection with all details
inspectionRoutes.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inspections')
      .select(`
        *,
        schedule_items(*),
        inspection_packages(*),
        checklist_results(*, checklist_templates(*))
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json({ success: true, inspection: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Prepare inspection package (pull all relevant docs)
inspectionRoutes.post('/:id/prepare', async (req, res) => {
  try {
    const pkg = await prepareInspection(req.params.id);
    res.json({ success: true, package: pkg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate QA/QC checklist for inspection
inspectionRoutes.post('/:id/checklist', async (req, res) => {
  try {
    const checklist = await generateInspectionChecklist(req.params.id);
    res.json({ success: true, checklist });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Record inspection result
inspectionRoutes.post('/:id/result', async (req, res) => {
  try {
    const { status, notes, checklistResults, photoIds } = req.body;

    if (!status) {
      return res.status(400).json({ success: false, error: 'status (pass/fail/conditional/deferred) is required' });
    }

    const result = await recordInspectionResult(req.params.id, {
      status, notes, checklistResults, photoIds
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Accept or dismiss a suggested inspection
inspectionRoutes.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body; // upcoming, cancelled, deferred

    const { data, error } = await supabase
      .from('inspections')
      .update({ status })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, inspection: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create a manual inspection (not from schedule)
inspectionRoutes.post('/', async (req, res) => {
  try {
    const {
      projectId, userId, inspectionType, title, description,
      scheduledDate, scheduledTime, location, gridLines, floorLevel
    } = req.body;

    if (!projectId || !userId || !inspectionType || !title || !scheduledDate) {
      return res.status(400).json({
        success: false,
        error: 'projectId, userId, inspectionType, title, and scheduledDate are required'
      });
    }

    const { data, error } = await supabase
      .from('inspections')
      .insert({
        project_id: projectId,
        user_id: userId,
        inspection_type: inspectionType,
        title,
        description,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        location,
        grid_lines: gridLines,
        floor_level: floorLevel,
        status: 'upcoming'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, inspection: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
