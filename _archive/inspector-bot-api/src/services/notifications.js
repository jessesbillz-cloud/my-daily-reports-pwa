/**
 * Notification Service
 * Handles sending messages via iMessage (AppleScript) when running locally on Mac.
 * When running on Railway, messages are returned via API response instead.
 *
 * For beta: everything goes through iMessage on your Mac.
 * The iMessage watcher (imessage-watcher.js) handles the send/receive loop.
 * This service handles the LOGIC of what to send and when.
 */
import { supabase } from '../utils/supabase.js';
import { config } from '../../config/index.js';
import { execSync } from 'child_process';

/**
 * Send a message via iMessage (only works when running locally on Mac)
 * When running on Railway, messages are returned via API response instead
 */
export async function sendMessage(to, body, options = {}) {
  const { inspectionId, userId } = options;

  // Log the notification regardless of delivery method
  if (userId) {
    await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        inspection_id: inspectionId || null,
        channel: 'imessage',
        body,
        status: 'sent',
        sent_at: new Date().toISOString()
      });
  }

  // Try to send via iMessage (only works on macOS with Messages app)
  if (to && process.platform === 'darwin') {
    try {
      sendiMessage(to, body);
      return { sent: true, channel: 'imessage' };
    } catch (err) {
      console.warn('iMessage send failed (expected on server):', err.message);
    }
  }

  // On server: return the message — the API endpoint will include it in the response
  return { sent: false, channel: 'api_response', body };
}

/**
 * Send an iMessage using AppleScript
 */
function sendiMessage(to, text) {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const script = `tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${to}" of targetService
    send "${escaped}" to targetBuddy
  end tell`;

  execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
}

/**
 * Send inspection reminder
 */
export async function sendInspectionReminder(inspectionId) {
  const { data: inspection } = await supabase
    .from('inspections')
    .select(`
      *,
      projects(name),
      bot_users(phone, full_name, preferences)
    `)
    .eq('id', inspectionId)
    .single();

  if (!inspection) return null;

  const user = inspection.bot_users;
  const phone = user?.phone;

  const dateStr = new Date(inspection.scheduled_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const body = `🔍 Inspector Bot Reminder\n\n${inspection.title}\n📅 ${dateStr}${inspection.scheduled_time ? ` at ${inspection.scheduled_time}` : ''}\n📍 ${inspection.location || inspection.projects?.name || 'TBD'}\n\nReply "PREP" for your inspection package.`;

  return sendMessage(phone, body, {
    inspectionId,
    userId: inspection.user_id
  });
}

/**
 * Send inspection prep package summary
 */
export async function sendPrepSummary(inspectionId) {
  const { data: pkg } = await supabase
    .from('inspection_packages')
    .select('*')
    .eq('inspection_id', inspectionId)
    .single();

  if (!pkg) return null;

  const { data: inspection } = await supabase
    .from('inspections')
    .select('*, bot_users(phone)')
    .eq('id', inspectionId)
    .single();

  if (!inspection) return null;

  const lines = [`📋 Prep: ${inspection.title}\n`];

  if (pkg.rfis?.length > 0) {
    lines.push(`📄 RFIs: ${pkg.rfis.map(r => r.number).join(', ')}`);
  }
  if (pkg.submittals?.length > 0) {
    lines.push(`📦 Submittals: ${pkg.submittals.map(s => s.number).join(', ')}`);
  }
  if (pkg.plan_sheets?.length > 0) {
    lines.push(`📐 Plans: ${pkg.plan_sheets.map(p => p.sheet).join(', ')}`);
  }
  if (pkg.spec_sections?.length > 0) {
    lines.push(`📖 Specs: ${pkg.spec_sections.map(s => s.section).join(', ')}`);
  }

  if (pkg.key_items?.length > 0) {
    lines.push(`\n⚠️ Key items:`);
    pkg.key_items.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${typeof item === 'string' ? item : item.item?.substring(0, 80)}`);
    });
  }

  return sendMessage(inspection.bot_users?.phone, lines.join('\n'), {
    inspectionId,
    userId: inspection.user_id
  });
}

/**
 * Process incoming commands (PREP, DONE, etc.)
 * Returns null if not a command — let session system handle it
 */
export async function processCommand(userId, body) {
  const message = body.trim().toUpperCase();

  // Command: PREP
  if (message === 'PREP') {
    const { data: nextInspection } = await supabase
      .from('inspections')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['upcoming', 'suggested'])
      .order('scheduled_date', { ascending: true })
      .limit(1)
      .single();

    if (nextInspection) {
      await sendPrepSummary(nextInspection.id);
      return { message: 'Prep package sent!' };
    }
    return { message: 'No upcoming inspections found.' };
  }

  // Command: DONE / ALL GOOD / PASS / FAIL
  if (message.startsWith('DONE') || message.startsWith('ALL GOOD') || message.startsWith('PASS') || message.startsWith('FAIL')) {
    const result = message.includes('FAIL') ? 'fail' : 'pass';
    const notes = body.replace(/^(DONE|ALL GOOD|PASS|FAIL)\s*/i, '').trim();

    const { data: current } = await supabase
      .from('inspections')
      .select('id, title')
      .eq('user_id', userId)
      .eq('status', 'in_progress')
      .order('scheduled_date', { ascending: false })
      .limit(1)
      .single();

    if (current) {
      const { recordInspectionResult } = await import('./inspections.js');
      const { dailyReportText } = await recordInspectionResult(current.id, {
        status: result,
        notes: notes || `Inspection ${result === 'pass' ? 'passed' : 'failed'}`
      });

      return {
        message: `✅ ${current.title} marked as ${result.toUpperCase()}.\n\nDaily report entry:\n${dailyReportText}`
      };
    }
    return { message: 'No active inspection found.' };
  }

  // Not a command
  return null;
}

/**
 * Check for inspections that need reminders (called by cron)
 */
export async function checkAndSendReminders() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const { data: inspections } = await supabase
    .from('inspections')
    .select('id')
    .in('status', ['upcoming', 'suggested'])
    .eq('scheduled_date', tomorrowStr)
    .eq('reminder_sent', false);

  if (!inspections?.length) return { sent: 0 };

  let sent = 0;
  for (const inspection of inspections) {
    try {
      await sendInspectionReminder(inspection.id);
      await supabase
        .from('inspections')
        .update({ reminder_sent: true })
        .eq('id', inspection.id);
      sent++;
    } catch (err) {
      console.error(`Failed to send reminder for ${inspection.id}:`, err);
    }
  }

  return { sent };
}
