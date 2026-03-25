/**
 * Inspection Service
 * Handles: inspection prep, checklist generation, daily report text, result tracking
 */
import { supabase } from '../utils/supabase.js';
import { queryLLM, generateChecklist, generateDailyReportText } from '../utils/ai.js';
import { queryProject } from './rag.js';
import { config } from '../../config/index.js';

/**
 * Prepare an inspection package
 * Pulls all relevant RFIs, submittals, spec sections, plan sheets
 */
export async function prepareInspection(inspectionId) {
  // Get inspection details
  const { data: inspection, error } = await supabase
    .from('inspections')
    .select(`
      *,
      schedule_items(*)
    `)
    .eq('id', inspectionId)
    .single();

  if (error || !inspection) throw new Error('Inspection not found');

  const projectId = inspection.project_id;

  // Determine what to search for based on inspection type and schedule activity
  const searchTerms = [
    inspection.inspection_type,
    inspection.title,
    inspection.schedule_items?.activity_name,
    inspection.schedule_items?.trade,
    inspection.location
  ].filter(Boolean);

  const searchQuery = searchTerms.join(' ');

  // Use RAG to find all relevant documents
  const ragResult = await queryProject(projectId, `
    Find all relevant spec sections, RFIs, submittals, and plan references for:
    ${searchQuery}
    Include product specifications, approved materials, code requirements, and any changes from RFIs.
  `, {
    skipCache: true,
    filterCategory: null // Search everything
  });

  // Separate citations by category
  const specSections = ragResult.citations.filter(c => c.doc_category === 'spec');
  const rfis = ragResult.citations.filter(c => c.doc_category === 'rfi');
  const submittals = ragResult.citations.filter(c => c.doc_category === 'submittal');
  const planSheets = ragResult.citations.filter(c => c.plan_sheet);

  // Build key items to check
  const keyItems = [];
  for (const citation of ragResult.citations) {
    if (citation.snippet) {
      keyItems.push({
        item: citation.snippet,
        source: citation.document_title,
        category: citation.doc_category,
        reference: citation.reference_number,
        page: citation.page_number
      });
    }
  }

  // Store the prep package
  const { data: pkg, error: pkgErr } = await supabase
    .from('inspection_packages')
    .upsert({
      inspection_id: inspectionId,
      project_id: projectId,
      relevant_documents: ragResult.citations,
      spec_sections: specSections.map(s => ({
        section: s.spec_section,
        title: s.document_title,
        page: s.page_number
      })),
      plan_sheets: [...new Set(planSheets.map(p => p.plan_sheet))].map(sheet => ({
        sheet,
        document: planSheets.find(p => p.plan_sheet === sheet)?.document_title
      })),
      rfis: rfis.map(r => ({
        number: r.reference_number,
        title: r.document_title,
        page: r.page_number
      })),
      submittals: submittals.map(s => ({
        number: s.reference_number,
        title: s.document_title,
        page: s.page_number
      })),
      ai_summary: ragResult.content,
      key_items: keyItems
    }, {
      onConflict: 'inspection_id'
    })
    .select()
    .single();

  if (pkgErr) throw new Error(`Failed to save inspection package: ${pkgErr.message}`);

  // Update inspection status
  await supabase
    .from('inspections')
    .update({ prep_sent: true, status: 'upcoming' })
    .eq('id', inspectionId);

  return pkg;
}

/**
 * Generate a QA/QC checklist for an inspection
 */
export async function generateInspectionChecklist(inspectionId) {
  const { data: inspection } = await supabase
    .from('inspections')
    .select('*, inspection_packages(*)')
    .eq('id', inspectionId)
    .single();

  if (!inspection) throw new Error('Inspection not found');

  const projectId = inspection.project_id;

  // Get relevant spec content
  const specContent = [];
  const rfiContent = [];
  const submittalContent = [];

  if (inspection.inspection_packages?.length > 0) {
    const pkg = inspection.inspection_packages[0];

    // Get full text of relevant spec sections
    for (const spec of (pkg.spec_sections || [])) {
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('content')
        .eq('project_id', projectId)
        .eq('spec_section', spec.section)
        .limit(5);

      if (chunks) {
        specContent.push(...chunks.map(c => c.content));
      }
    }

    // Get RFI content
    for (const rfi of (pkg.rfis || [])) {
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('content')
        .eq('project_id', projectId)
        .eq('reference_number', rfi.number)
        .limit(3);

      if (chunks) {
        rfiContent.push({ number: rfi.number, content: chunks.map(c => c.content).join('\n') });
      }
    }

    // Get submittal content
    for (const sub of (pkg.submittals || [])) {
      const { data: chunks } = await supabase
        .from('document_chunks')
        .select('content')
        .eq('project_id', projectId)
        .eq('reference_number', sub.number)
        .limit(3);

      if (chunks) {
        submittalContent.push({ number: sub.number, content: chunks.map(c => c.content).join('\n') });
      }
    }
  }

  // Generate checklist via AI
  const checklistItems = await generateChecklist(
    inspection.inspection_type,
    specContent.join('\n\n---\n\n'),
    rfiContent,
    submittalContent
  );

  // Store as a checklist template
  const { data: template, error } = await supabase
    .from('checklist_templates')
    .upsert({
      project_id: projectId,
      inspection_type: inspection.inspection_type,
      trade: inspection.inspection_type,
      title: `${inspection.title} - QA/QC Checklist`,
      items: checklistItems,
      source_chunk_ids: []
    }, {
      onConflict: 'project_id,inspection_type'
    })
    .select()
    .single();

  // Upsert might not have onConflict set up, insert if needed
  if (error) {
    const { data: newTemplate } = await supabase
      .from('checklist_templates')
      .insert({
        project_id: projectId,
        inspection_type: inspection.inspection_type,
        trade: inspection.inspection_type,
        title: `${inspection.title} - QA/QC Checklist`,
        items: checklistItems
      })
      .select()
      .single();

    return newTemplate;
  }

  return template;
}

/**
 * Record inspection results
 */
export async function recordInspectionResult(inspectionId, result) {
  const {
    status,        // pass, fail, conditional, deferred
    notes,
    checklistResults,
    photoIds
  } = result;

  // Update inspection
  const { data: inspection, error } = await supabase
    .from('inspections')
    .update({
      status: 'completed',
      result: status,
      result_notes: notes,
      photo_ids: photoIds || []
    })
    .eq('id', inspectionId)
    .select()
    .single();

  if (error) throw new Error(`Failed to record result: ${error.message}`);

  // Store checklist results if provided
  if (checklistResults) {
    // Find the checklist template for this inspection
    const { data: templates } = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('project_id', inspection.project_id)
      .eq('inspection_type', inspection.inspection_type)
      .limit(1);

    if (templates?.length > 0) {
      await supabase
        .from('checklist_results')
        .insert({
          inspection_id: inspectionId,
          template_id: templates[0].id,
          results: checklistResults,
          completed_at: new Date().toISOString()
        });
    }
  }

  // Get photos for report text generation
  let photos = [];
  if (photoIds?.length > 0) {
    const { data } = await supabase
      .from('inspection_photos')
      .select('ai_description')
      .in('id', photoIds);
    photos = data || [];
  }

  // Generate daily report text
  const reportText = await generateDailyReportText(
    inspection,
    checklistResults || [],
    photos
  );

  // Store the daily report text
  await supabase
    .from('inspections')
    .update({ daily_report_text: reportText })
    .eq('id', inspectionId);

  return {
    inspection,
    dailyReportText: reportText
  };
}

/**
 * Get inspection history for a project
 */
export async function getInspectionHistory(projectId, filters = {}) {
  let query = supabase
    .from('inspections')
    .select(`
      *,
      schedule_items(activity_name, trade),
      checklist_results(results, completed_at)
    `)
    .eq('project_id', projectId)
    .order('scheduled_date', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.trade) query = query.eq('inspection_type', filters.trade);
  if (filters.dateFrom) query = query.gte('scheduled_date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('scheduled_date', filters.dateTo);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch history: ${error.message}`);
  return data || [];
}
