/**
 * Session & Context Service
 * Handles the inspector's active work session:
 *   - "I'm at Woodland Park" → switches active project, stages daily report
 *   - "Heading to Hunter Hall" → closes current, opens new
 *   - "All done for the day" → wraps up everything
 *
 * This carries over the multi-project day flow from the original inspection-bot:
 *   Morning at Woodland Park → afternoon at Hunter Hall → back to Woodland Park
 *   Each project gets its own daily report, notes accumulate as you go.
 */
import { supabase } from '../utils/supabase.js';
import { config } from '../../config/index.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Parse an incoming message to detect intent:
 * - Arrival at a project ("I'm at Woodland Park", "heading to Hunter Hall")
 * - Departure / wrap-up ("see you then", "leaving now", "done for the day")
 * - Inspection note ("checked the floor drains, all good per RFI 225")
 * - Question ("what anchor is on GL 12?")
 * - Photo with context
 * - Command (PREP, DONE, etc.)
 */
export async function parseMessage(messageText, userId) {
  // Get user's projects for context
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, project_number, site_address')
    .eq('user_id', userId)
    .eq('status', 'active');

  const projectNames = (projects || []).map(p => p.name);

  // Get current active session
  const session = await getActiveSession(userId);

  const response = await anthropic.messages.create({
    model: config.AI_TIER_1, // Haiku for fast parsing
    max_tokens: 500,
    system: `You are parsing messages from a construction inspector in the field. Determine the intent and extract relevant info.

The inspector's active projects: ${projectNames.join(', ')}
${session ? `Currently at: ${session.project_name}` : 'Not currently at any project.'}

Respond with JSON only (no markdown code fences):
{
  "intent": "arrival" | "departure" | "note" | "question" | "command" | "photo_note" | "done_for_day",
  "project": "project name or null",
  "content": "the actual note/question text, cleaned up",
  "result": "pass" | "fail" | null (if reporting an inspection result),
  "confidence": 0.0-1.0
}

Rules:
- Project names can be partial matches ("Woodland" → "Woodland Park", "Hunter" → "Hunter Hall")
- "I'm at X", "heading to X", "going to X", "at X now" = arrival
- "leaving", "see you", "heading out", "done here", "wrapping up" = departure
- "all done", "done for the day", "that's it" = done_for_day
- "all good", "looks good", "passed" = note with result "pass"
- "failed", "no good", "rejected" = note with result "fail"
- If they mention a project in a note, it's for that project (not a switch)
- Questions contain "what", "where", "which", "how", "is the", "find me", "show me"
- If ambiguous between note and question, prefer note if they seem to be reporting observations`,
    messages: [{ role: 'user', content: messageText }]
  });

  try {
    let text = response.content[0].text.trim();
    text = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(text);

    // Resolve project name to ID
    if (parsed.project) {
      const match = (projects || []).find(p =>
        p.name.toLowerCase().includes(parsed.project.toLowerCase()) ||
        parsed.project.toLowerCase().includes(p.name.toLowerCase().split(' ')[0])
      );
      if (match) {
        parsed.projectId = match.id;
        parsed.project = match.name;
      }
    }

    // Default to active session's project if no project mentioned
    if (!parsed.projectId && session && ['note', 'question', 'photo_note', 'departure'].includes(parsed.intent)) {
      parsed.projectId = session.project_id;
      parsed.project = session.project_name;
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse message intent:', e);
    return {
      intent: 'note',
      project: session?.project_name || null,
      projectId: session?.project_id || null,
      content: messageText,
      result: null,
      confidence: 0.5
    };
  }
}

/**
 * Get user's currently active session (which project they're at)
 */
export async function getActiveSession(userId) {
  const { data } = await supabase
    .from('active_sessions')
    .select('*, projects(name)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();

  if (data) {
    return {
      ...data,
      project_name: data.projects?.name
    };
  }
  return null;
}

/**
 * Start a session at a project (inspector arrives)
 * - Stages the daily report
 * - Loads project context
 * - Sends confirmation
 */
export async function startSession(userId, projectId) {
  // Close any existing active session first
  await endSession(userId, false);

  // Get project info
  const { data: project } = await supabase
    .from('projects')
    .select('name, is_dsa')
    .eq('id', projectId)
    .single();

  // Create active session
  const { data: session, error } = await supabase
    .from('active_sessions')
    .insert({
      user_id: userId,
      project_id: projectId,
      status: 'active',
      started_at: new Date().toISOString(),
      notes_today: [],
      photos_today: []
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to start session: ${error.message}`);

  // Check for today's daily report or create a new one
  const reportInfo = await stageOrCreateDailyReport(userId, projectId);

  // Check for upcoming inspections at this project
  const today = new Date().toISOString().split('T')[0];
  const { data: todayInspections } = await supabase
    .from('inspections')
    .select('id, title, inspection_type, status')
    .eq('project_id', projectId)
    .eq('scheduled_date', today)
    .in('status', ['upcoming', 'suggested']);

  return {
    session,
    project: project?.name,
    report: reportInfo,
    todayInspections: todayInspections || [],
    message: buildArrivalMessage(project?.name, reportInfo, todayInspections)
  };
}

/**
 * End a session at a project (inspector leaves)
 * Saves accumulated notes to the daily report
 */
export async function endSession(userId, sendSummary = true) {
  const session = await getActiveSession(userId);
  if (!session) return null;

  // Mark session as completed
  const { data: updated } = await supabase
    .from('active_sessions')
    .update({
      status: 'completed',
      ended_at: new Date().toISOString()
    })
    .eq('id', session.id)
    .select()
    .single();

  if (sendSummary) {
    const noteCount = session.notes_today?.length || 0;
    const photoCount = session.photos_today?.length || 0;

    return {
      session: updated,
      message: `✅ Wrapped up at ${session.project_name}. ${noteCount} note${noteCount !== 1 ? 's' : ''} and ${photoCount} photo${photoCount !== 1 ? 's' : ''} logged today.`
    };
  }

  return { session: updated };
}

/**
 * End all sessions for the day
 */
export async function endDay(userId) {
  const session = await getActiveSession(userId);
  if (session) {
    await endSession(userId, false);
  }

  // Get all sessions from today
  const today = new Date().toISOString().split('T')[0];
  const { data: todaySessions } = await supabase
    .from('active_sessions')
    .select('*, projects(name)')
    .eq('user_id', userId)
    .gte('started_at', today)
    .order('started_at', { ascending: true });

  const summaryLines = ['📋 Day Summary:'];
  for (const s of (todaySessions || [])) {
    const noteCount = s.notes_today?.length || 0;
    const photoCount = s.photos_today?.length || 0;
    summaryLines.push(`• ${s.projects?.name}: ${noteCount} notes, ${photoCount} photos`);
  }

  return {
    message: summaryLines.join('\n'),
    sessions: todaySessions
  };
}

/**
 * Add a note to the active session
 * Appends to the running list and updates the daily report
 */
export async function addNoteToSession(userId, noteText, result = null) {
  const session = await getActiveSession(userId);
  if (!session) {
    return { error: 'No active project. Text me which project you\'re at to get started.' };
  }

  // Add note to session's running list
  const notes = session.notes_today || [];
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const noteEntry = {
    text: noteText,
    timestamp,
    result,
    added_at: new Date().toISOString()
  };
  notes.push(noteEntry);

  await supabase
    .from('active_sessions')
    .update({ notes_today: notes })
    .eq('id', session.id);

  // Get or create today's report
  const reportInfo = await stageOrCreateDailyReport(userId, session.project_id);

  // Add note to the daily report record
  if (reportInfo.reportId) {
    const { data: report } = await supabase
      .from('daily_reports')
      .select('notes')
      .eq('id', reportInfo.reportId)
      .single();

    const existingNotes = report?.notes || [];
    existingNotes.push(noteEntry);

    await supabase
      .from('daily_reports')
      .update({ notes: existingNotes })
      .eq('id', reportInfo.reportId);
  }

  // Format confirmation - keep it short like the original bot
  const projectShort = session.project_name.split(' ')[0];
  const prefix = result === 'pass' ? '✅' : result === 'fail' ? '❌' : '📝';

  return {
    message: `${prefix} ${projectShort}: ${noteText.substring(0, 60)}${noteText.length > 60 ? '...' : ''}`,
    noteCount: notes.length
  };
}

/**
 * Add a photo to the active session
 */
export async function addPhotoToSession(userId, photoId) {
  const session = await getActiveSession(userId);
  if (!session) return;

  const photos = session.photos_today || [];
  photos.push(photoId);

  await supabase
    .from('active_sessions')
    .update({ photos_today: photos })
    .eq('id', session.id);
}

/**
 * Stage or create today's daily report for a project
 */
async function stageOrCreateDailyReport(userId, projectId) {
  const today = new Date().toISOString().split('T')[0];

  // Check if we already have today's report
  const { data: existing } = await supabase
    .from('daily_reports')
    .select('id, report_number, status')
    .eq('project_id', projectId)
    .eq('report_date', today)
    .single();

  if (existing) {
    return {
      reportId: existing.id,
      reportNumber: existing.report_number,
      isNew: false,
      status: existing.status
    };
  }

  // Find the next report number
  const { data: lastReport } = await supabase
    .from('daily_reports')
    .select('report_number')
    .eq('project_id', projectId)
    .order('report_number', { ascending: false })
    .limit(1)
    .single();

  const nextNumber = (lastReport?.report_number || 0) + 1;

  // Create today's report
  const { data: newReport, error } = await supabase
    .from('daily_reports')
    .insert({
      project_id: projectId,
      user_id: userId,
      report_date: today,
      report_number: nextNumber,
      status: 'draft',
      notes: [],
      photos: [],
      weather: null,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create daily report:', error);
    return { reportId: null, reportNumber: nextNumber, isNew: true, status: 'draft' };
  }

  return {
    reportId: newReport.id,
    reportNumber: nextNumber,
    isNew: true,
    status: 'draft'
  };
}

/**
 * Build the arrival confirmation message
 */
function buildArrivalMessage(projectName, reportInfo, inspections) {
  const lines = [];

  if (reportInfo.isNew) {
    lines.push(`📋 ${projectName} - DR #${reportInfo.reportNumber} created and standing by.`);
  } else {
    lines.push(`📋 ${projectName} - DR #${reportInfo.reportNumber} already started, picking up where you left off.`);
  }

  if (inspections?.length > 0) {
    lines.push(`\n🔍 Inspections scheduled today:`);
    for (const insp of inspections) {
      lines.push(`• ${insp.title}`);
    }
    lines.push(`\nReply "PREP" for inspection packages.`);
  }

  lines.push(`\nSend notes anytime — I'll add them to your report.`);

  return lines.join('\n');
}

/**
 * Process a full incoming message through the session system
 * This is the main entry point that handles the whole flow
 */
export async function processMessage(userId, messageText, photoIds = []) {
  const parsed = await parseMessage(messageText, userId);

  switch (parsed.intent) {
    case 'arrival': {
      if (!parsed.projectId) {
        return { message: `❓ I don't recognize that project. Your projects: ${(await getUserProjectNames(userId)).join(', ')}` };
      }
      const result = await startSession(userId, parsed.projectId);

      // If they included notes with arrival, add those too
      if (parsed.content && parsed.content !== parsed.project) {
        await addNoteToSession(userId, parsed.content, parsed.result);
      }

      return result;
    }

    case 'departure': {
      const result = await endSession(userId);
      if (!result) {
        return { message: "You're not checked in anywhere. Text a project name to start." };
      }
      return result;
    }

    case 'done_for_day': {
      return endDay(userId);
    }

    case 'note':
    case 'photo_note': {
      // Add photos if provided
      for (const photoId of photoIds) {
        await addPhotoToSession(userId, photoId);
      }

      if (parsed.content) {
        return addNoteToSession(userId, parsed.content, parsed.result);
      }

      if (photoIds.length > 0) {
        return { message: `📸 ${photoIds.length} photo(s) added to your report.` };
      }

      return { message: "Got it, but I couldn't tell what the note was. Try again?" };
    }

    case 'question': {
      // This gets routed to RAG - import dynamically to avoid circular deps
      const { queryProject } = await import('./rag.js');
      const projectId = parsed.projectId;

      if (!projectId) {
        return { message: "Which project is this question about? Text a project name first." };
      }

      const answer = await queryProject(projectId, parsed.content || messageText, { userId });
      return {
        message: answer.content,
        citations: answer.citations
      };
    }

    case 'command': {
      // Handle PREP, DONE, etc. - delegate to notification service
      const { processCommand } = await import('./notifications.js');
      const cmdResult = await processCommand(userId, messageText);
      return cmdResult || { message: "I didn't understand that command. Try PREP or DONE." };
    }

    default:
      return { message: "I'm not sure what you mean. Send a project name to start, or ask a question about your docs." };
  }
}

async function getUserProjectNames(userId) {
  const { data } = await supabase
    .from('projects')
    .select('name')
    .eq('user_id', userId)
    .eq('status', 'active');
  return (data || []).map(p => p.name);
}
