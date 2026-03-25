/**
 * Schedule Service
 * Handles: schedule import → parse → analyze for inspections → create inspection records
 */
import { supabase } from '../utils/supabase.js';
import { analyzeScheduleForInspections } from '../utils/ai.js';
import XLSX from 'xlsx';
import fs from 'fs/promises';

/**
 * Import a construction schedule from Excel/CSV
 * Supports: P6 export, MS Project export, generic Excel schedule
 */
export async function importSchedule(file, projectId) {
  const fileBuffer = await fs.readFile(file.path);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });

  // Use first sheet
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rawData.length === 0) {
    throw new Error('Schedule file is empty or could not be parsed');
  }

  // Detect column mapping (different schedule tools use different headers)
  const columnMap = detectColumns(rawData[0]);

  // Parse activities
  const activities = rawData.map((row, index) => ({
    project_id: projectId,
    activity_id: String(row[columnMap.activityId] || `ACT-${index + 1}`),
    activity_name: String(row[columnMap.activityName] || '').trim(),
    start_date: parseDate(row[columnMap.startDate]),
    finish_date: parseDate(row[columnMap.finishDate]),
    actual_start: columnMap.actualStart ? parseDate(row[columnMap.actualStart]) : null,
    actual_finish: columnMap.actualFinish ? parseDate(row[columnMap.actualFinish]) : null,
    duration_days: parseInt(row[columnMap.duration]) || null,
    percent_complete: parseFloat(row[columnMap.percentComplete]) || 0,
    trade: detectTrade(String(row[columnMap.activityName] || '')),
    location: String(row[columnMap.location] || '').trim() || null,
    status: 'not_started',
    tracked: true,
    raw_data: row
  })).filter(a => a.activity_name); // Filter out empty rows

  // Insert into database
  const { data: inserted, error } = await supabase
    .from('schedule_items')
    .insert(activities)
    .select();

  if (error) throw new Error(`Failed to import schedule: ${error.message}`);

  return {
    success: true,
    activitiesImported: inserted.length,
    columnMapping: columnMap,
    activities: inserted
  };
}

/**
 * Analyze schedule for required inspections
 * Uses AI to determine what inspections are needed based on activities
 */
export async function analyzeForInspections(projectId, userId) {
  // Get all tracked schedule items
  const { data: items, error } = await supabase
    .from('schedule_items')
    .select('*')
    .eq('project_id', projectId)
    .eq('tracked', true)
    .order('start_date', { ascending: true });

  if (error) throw new Error(`Failed to fetch schedule: ${error.message}`);
  if (!items?.length) return { inspections: [], message: 'No tracked schedule items found' };

  // Get project context
  const { data: project } = await supabase
    .from('projects')
    .select('name, is_dsa, dsa_app_number')
    .eq('id', projectId)
    .single();

  const projectContext = `Project: ${project?.name || 'Unknown'}. ${project?.is_dsa ? 'DSA project - Division of State Architect requirements apply.' : 'Non-DSA project.'}`;

  // Batch activities for AI analysis (groups of 20)
  const BATCH_SIZE = 20;
  const allSuggestions = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE).map(item => ({
      id: item.id,
      activity_id: item.activity_id,
      activity_name: item.activity_name,
      trade: item.trade,
      start_date: item.start_date,
      finish_date: item.finish_date,
      location: item.location
    }));

    const suggestions = await analyzeScheduleForInspections(batch, projectContext);
    allSuggestions.push(...suggestions.map(s => ({
      ...s,
      schedule_item: batch.find(b => b.activity_name === s.activity_name || b.activity_id === s.activity_id) || batch[0]
    })));
  }

  // Create inspection records (as suggestions)
  const inspections = [];
  for (const suggestion of allSuggestions) {
    const scheduleItem = suggestion.schedule_item;
    if (!scheduleItem) continue;

    const inspection = {
      project_id: projectId,
      user_id: userId,
      schedule_item_id: scheduleItem.id,
      inspection_type: suggestion.inspection_type || suggestion.trade || 'general',
      title: suggestion.inspection_type
        ? `${suggestion.inspection_type} - ${scheduleItem.activity_name}`
        : scheduleItem.activity_name,
      description: suggestion.checklist_items?.join('; ') || null,
      scheduled_date: calculateInspectionDate(scheduleItem, suggestion.timing),
      location: scheduleItem.location,
      status: 'suggested'
    };

    inspections.push(inspection);
  }

  if (inspections.length > 0) {
    const { data: created, error: insertErr } = await supabase
      .from('inspections')
      .insert(inspections)
      .select();

    if (insertErr) throw new Error(`Failed to create inspections: ${insertErr.message}`);

    // Also create checklist templates for each
    for (const insp of created) {
      const suggestion = allSuggestions.find(s =>
        s.inspection_type === insp.inspection_type ||
        insp.title.includes(s.inspection_type)
      );

      if (suggestion?.checklist_items?.length > 0) {
        await supabase
          .from('checklist_templates')
          .insert({
            project_id: projectId,
            inspection_type: insp.inspection_type,
            trade: suggestion.trade,
            title: `${insp.inspection_type} Checklist`,
            items: suggestion.checklist_items.map((item, idx) => ({
              item,
              code_ref: suggestion.relevant_codes?.[idx] || null,
              required: true
            }))
          });
      }
    }

    return {
      inspections: created,
      message: `Found ${created.length} inspections needed from ${items.length} schedule activities`
    };
  }

  return {
    inspections: [],
    message: 'No inspections identified from the current schedule'
  };
}

/**
 * Get upcoming inspections with prep packages
 */
export async function getUpcomingInspections(projectId, daysAhead = 7) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const { data, error } = await supabase
    .from('inspections')
    .select(`
      *,
      schedule_items(*),
      inspection_packages(*),
      checklist_templates(*)
    `)
    .eq('project_id', projectId)
    .in('status', ['suggested', 'upcoming'])
    .lte('scheduled_date', futureDate.toISOString().split('T')[0])
    .order('scheduled_date', { ascending: true });

  if (error) throw new Error(`Failed to fetch inspections: ${error.message}`);
  return data || [];
}

/**
 * Update schedule item tracking preferences
 * (What the inspector wants to see vs not)
 */
export async function updateTrackingPreferences(projectId, preferences) {
  // preferences: [{ id: "...", tracked: true/false, notes: "..." }, ...]
  for (const pref of preferences) {
    await supabase
      .from('schedule_items')
      .update({
        tracked: pref.tracked,
        notes: pref.notes || null
      })
      .eq('id', pref.id)
      .eq('project_id', projectId);
  }

  return { success: true, updated: preferences.length };
}

// ========== Helper functions ==========

/**
 * Detect column names from schedule export
 * Different tools (P6, MS Project, etc.) use different headers
 */
function detectColumns(firstRow) {
  const keys = Object.keys(firstRow);
  const lower = keys.map(k => k.toLowerCase());

  const find = (patterns) => {
    for (const pattern of patterns) {
      const idx = lower.findIndex(k => k.includes(pattern));
      if (idx >= 0) return keys[idx];
    }
    return null;
  };

  return {
    activityId: find(['activity id', 'task id', 'wbs', 'id']) || keys[0],
    activityName: find(['activity name', 'task name', 'description', 'name']) || keys[1],
    startDate: find(['start', 'planned start', 'early start', 'begin']) || keys[2],
    finishDate: find(['finish', 'end', 'planned finish', 'early finish']) || keys[3],
    actualStart: find(['actual start']),
    actualFinish: find(['actual finish']),
    duration: find(['duration', 'original duration', 'days']),
    percentComplete: find(['percent', '% complete', 'progress']),
    location: find(['location', 'area', 'zone', 'building']),
  };
}

/**
 * Detect trade/discipline from activity name
 */
function detectTrade(activityName) {
  const lower = activityName.toLowerCase();
  const trades = {
    plumbing: ['plumb', 'drain', 'pipe', 'water', 'sewer', 'fixture', 'trap'],
    electrical: ['electric', 'power', 'panel', 'conduit', 'wire', 'lighting', 'switch'],
    structural: ['struct', 'steel', 'concrete', 'foundation', 'rebar', 'anchor', 'footing'],
    mechanical: ['hvac', 'mechanical', 'duct', 'air handler', 'diffuser', 'thermostat'],
    fire_protection: ['fire', 'sprinkler', 'alarm', 'extinguish', 'smoke'],
    framing: ['frame', 'framing', 'stud', 'wall', 'drywall', 'gypsum'],
    roofing: ['roof', 'membrane', 'flash', 'gutter', 'downspout'],
    waterproofing: ['waterproof', 'moisture', 'barrier', 'membrane', 'seal'],
    finish: ['finish', 'paint', 'tile', 'carpet', 'flooring', 'ceiling'],
    earthwork: ['earth', 'grade', 'excavat', 'backfill', 'compact', 'trench'],
    masonry: ['mason', 'block', 'brick', 'mortar', 'grout'],
    glazing: ['glaz', 'window', 'glass', 'curtain wall', 'storefront'],
    accessibility: ['ada', 'accessible', 'handicap', 'ramp', 'grab bar'],
  };

  for (const [trade, keywords] of Object.entries(trades)) {
    if (keywords.some(kw => lower.includes(kw))) return trade;
  }
  return 'general';
}

/**
 * Parse various date formats from schedule exports
 */
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

/**
 * Calculate when inspection should occur relative to activity
 */
function calculateInspectionDate(scheduleItem, timing) {
  const baseDate = scheduleItem.start_date || scheduleItem.finish_date;
  if (!baseDate) return new Date().toISOString().split('T')[0];

  const d = new Date(baseDate);
  switch (timing) {
    case 'before':
      d.setDate(d.getDate() - 1);
      break;
    case 'after':
      d.setDate(d.getDate() + 1);
      break;
    // 'during' = same as start date
  }
  return d.toISOString().split('T')[0];
}
