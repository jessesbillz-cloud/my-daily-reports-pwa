/**
 * Webhook Routes
 * Web API for iMessage watcher + cron triggers
 *
 * The iMessage watcher (running locally on Mac) calls POST /api/webhooks/message
 * with each new text message. This route processes it through the session system
 * and returns the bot's response. The watcher then sends it back via iMessage.
 */
import { Router } from 'express';
import { supabase } from '../utils/supabase.js';
import { processMessage, getActiveSession } from '../services/session.js';
import { checkAndSendReminders } from '../services/notifications.js';

export const webhookRoutes = Router();

// Main message endpoint - called by iMessage watcher or future web chat
webhookRoutes.post('/message', async (req, res) => {
  try {
    const { userId, message, photoIds } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ success: false, error: 'userId and message are required' });
    }

    const result = await processMessage(userId, message, photoIds || []);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Message processing error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get current session status
webhookRoutes.get('/session/:userId', async (req, res) => {
  try {
    const session = await getActiveSession(req.params.userId);
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron: check and send reminders
webhookRoutes.post('/cron/reminders', async (req, res) => {
  try {
    const authHeader = req.headers['x-cron-secret'];
    if (authHeader !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await checkAndSendReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

webhookRoutes.get('/cron/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
