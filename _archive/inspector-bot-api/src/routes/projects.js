/**
 * Project Routes
 * CRUD for construction projects
 */
import { Router } from 'express';
import { supabase } from '../utils/supabase.js';

export const projectRoutes = Router();

// Create project
projectRoutes.post('/', async (req, res) => {
  try {
    const { userId, name, siteAddress, projectNumber, dsaAppNumber, dsaFileNumber, isDsa, description } = req.body;

    if (!userId || !name) {
      return res.status(400).json({ success: false, error: 'userId and name are required' });
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        name,
        site_address: siteAddress,
        project_number: projectNumber,
        dsa_app_number: dsaAppNumber,
        dsa_file_number: dsaFileNumber,
        is_dsa: isDsa || false,
        description
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, project: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List projects for a user
projectRoutes.get('/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, projects: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get project details with document counts
projectRoutes.get('/:id', async (req, res) => {
  try {
    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // Get document counts by category
    const { data: docCounts } = await supabase
      .from('project_documents')
      .select('doc_category')
      .eq('project_id', req.params.id)
      .eq('processing_status', 'ready');

    const counts = {};
    (docCounts || []).forEach(d => {
      counts[d.doc_category] = (counts[d.doc_category] || 0) + 1;
    });

    // Get upcoming inspection count
    const { count: inspectionCount } = await supabase
      .from('inspections')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', req.params.id)
      .in('status', ['upcoming', 'suggested']);

    res.json({
      success: true,
      project,
      documentCounts: counts,
      upcomingInspections: inspectionCount || 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update project
projectRoutes.patch('/:id', async (req, res) => {
  try {
    const updates = {};
    const allowed = ['name', 'site_address', 'project_number', 'dsa_app_number', 'dsa_file_number', 'is_dsa', 'description', 'status', 'settings'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, project: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
