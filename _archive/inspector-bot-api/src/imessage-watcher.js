/**
 * iMessage Watcher
 * ================
 * Runs LOCALLY on your Mac. Polls ~/Library/Messages/chat.db for new messages,
 * sends them to the Inspector Bot API, and replies via iMessage using AppleScript.
 *
 * This is the "imessage-watcher.js" that documents.js referenced but was never built.
 *
 * Setup:
 *   1. Grant Full Disk Access to Terminal (System Preferences → Privacy → Full Disk Access)
 *   2. Set your phone number in .env as MY_PHONE_NUMBER=+1XXXXXXXXXX
 *   3. Run: npm run local
 *
 * How it works:
 *   - Reads macOS Messages SQLite database (chat.db) every 5 seconds
 *   - Filters for messages from YOUR phone number (so it only processes your texts)
 *   - Sends each new message to the Inspector Bot API
 *   - Sends the bot's response back via iMessage using osascript (AppleScript)
 *   - Handles attachments (photos) by reading them from ~/Library/Messages/Attachments
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== CONFIG ==========

// Your phone number (messages FROM this number get processed)
const MY_PHONE = process.env.MY_PHONE_NUMBER || '+1XXXXXXXXXX';

// Inspector Bot API URL (Railway or localhost)
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Your user ID in the Inspector Bot database
const MY_USER_ID = process.env.MY_USER_ID;

// Poll interval in milliseconds
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 5000;

// macOS Messages database
const CHAT_DB_PATH = path.join(process.env.HOME, 'Library/Messages/chat.db');

// ========== STATE ==========

let lastMessageRowId = 0;
let db = null;

// ========== FUNCTIONS ==========

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Open the Messages database (read-only)
 */
function openDB() {
  if (!fs.existsSync(CHAT_DB_PATH)) {
    console.error(`Messages database not found at ${CHAT_DB_PATH}`);
    console.error('Make sure you have Full Disk Access enabled for Terminal.');
    process.exit(1);
  }

  // Open read-only — we never write to the Messages database
  db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  log('Connected to Messages database');

  // Get the latest message rowid so we only process NEW messages
  const latest = db.prepare('SELECT MAX(ROWID) as maxId FROM message').get();
  lastMessageRowId = latest?.maxId || 0;
  log(`Starting from message ROWID ${lastMessageRowId}`);
}

/**
 * Normalize a phone number for comparison
 * iMessage stores numbers as "+1XXXXXXXXXX" or "XXXXXXXXXX"
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[\s\-\(\)]/g, '').replace(/^\+1/, '').replace(/^1/, '');
}

/**
 * Poll for new messages from MY phone number
 */
function getNewMessages() {
  const myPhoneNorm = normalizePhone(MY_PHONE);

  // Query for messages newer than our last seen ROWID
  // is_from_me = 1 means messages I SENT (from my phone to myself or the bot number)
  // We want messages I sent FROM my phone
  const stmt = db.prepare(`
    SELECT
      m.ROWID,
      m.text,
      m.date AS message_date,
      m.is_from_me,
      m.cache_has_attachments,
      h.id AS handle_id,
      h.service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ?
      AND m.text IS NOT NULL
      AND m.text != ''
    ORDER BY m.ROWID ASC
  `);

  const messages = stmt.all(lastMessageRowId);

  // Filter: only messages FROM me (is_from_me = 1) that were sent via iMessage
  // This captures texts I send to myself or to a specific bot number
  const myMessages = messages.filter(m => {
    // Option 1: Messages I sent (from my phone)
    if (m.is_from_me === 1) return true;
    // Option 2: Messages received from my phone number (if texting from another device)
    const handleNorm = normalizePhone(m.handle_id);
    return handleNorm === myPhoneNorm;
  });

  return myMessages;
}

/**
 * Get attachment file paths for a message
 */
function getAttachments(messageRowId) {
  const stmt = db.prepare(`
    SELECT a.filename, a.mime_type, a.transfer_name
    FROM attachment a
    JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
  `);

  const attachments = stmt.all(messageRowId);

  return attachments
    .filter(a => a.mime_type?.startsWith('image/'))
    .map(a => {
      // macOS stores paths with ~ prefix
      let filePath = a.filename;
      if (filePath?.startsWith('~')) {
        filePath = filePath.replace('~', process.env.HOME);
      }
      return { path: filePath, type: a.mime_type, name: a.transfer_name };
    })
    .filter(a => a.path && fs.existsSync(a.path));
}

/**
 * Send a message to the Inspector Bot API
 */
async function sendToBot(text, photoIds = []) {
  try {
    const response = await fetch(`${API_URL}/api/webhooks/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: MY_USER_ID,
        message: text,
        photoIds
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.message || data.response || 'Got it.';
  } catch (err) {
    log(`API error: ${err.message}`);
    return `⚠️ Bot error: ${err.message}`;
  }
}

/**
 * Upload a photo to the Inspector Bot API
 */
async function uploadPhoto(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const formData = new FormData();
    formData.append('photo', new Blob([fileBuffer]), path.basename(filePath));
    formData.append('userId', MY_USER_ID);
    // projectId will be filled in by the session system if active

    const response = await fetch(`${API_URL}/api/photos/upload`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.photo?.id;
  } catch (err) {
    log(`Photo upload error: ${err.message}`);
    return null;
  }
}

/**
 * Send an iMessage reply using AppleScript
 * This is the key piece — sends the bot's response back to your phone
 */
function sendiMessage(to, text) {
  // Escape text for AppleScript
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${to}" of targetService
      send "${escaped}" to targetBuddy
    end tell
  `;

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
    return true;
  } catch (err) {
    // Fallback: try sending to phone number directly
    const fallbackScript = `
      tell application "Messages"
        send "${escaped}" to buddy "${to}" of (service 1 whose service type is iMessage)
      end tell
    `;
    try {
      execSync(`osascript -e '${fallbackScript.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
      return true;
    } catch (err2) {
      log(`Failed to send iMessage: ${err2.message}`);
      return false;
    }
  }
}

/**
 * Process a single message
 */
async function processMessage(message) {
  log(`New message: "${message.text.substring(0, 80)}${message.text.length > 80 ? '...' : ''}"`);

  // Check for photo attachments
  let photoIds = [];
  if (message.cache_has_attachments) {
    const attachments = getAttachments(message.ROWID);
    for (const att of attachments) {
      log(`  Photo: ${att.name}`);
      const photoId = await uploadPhoto(att.path);
      if (photoId) photoIds.push(photoId);
    }
  }

  // Send to bot API
  const response = await sendToBot(message.text, photoIds);

  // Reply via iMessage
  log(`Bot: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
  sendiMessage(MY_PHONE, response);
}

/**
 * Main polling loop
 */
async function poll() {
  try {
    const messages = getNewMessages();

    if (messages.length > 0) {
      for (const msg of messages) {
        await processMessage(msg);
        // Update the last seen ROWID
        if (msg.ROWID > lastMessageRowId) {
          lastMessageRowId = msg.ROWID;
        }
      }
    }
  } catch (err) {
    // Database might be locked briefly when Messages app writes to it
    if (err.message?.includes('database is locked') || err.message?.includes('SQLITE_BUSY')) {
      // Silently retry next cycle
    } else {
      log(`Poll error: ${err.message}`);
    }
  }
}

/**
 * Startup
 */
function start() {
  console.log('');
  console.log('🔍 Inspector Bot - iMessage Watcher');
  console.log('====================================');
  console.log(`Phone: ${MY_PHONE}`);
  console.log(`API: ${API_URL}`);
  console.log(`Poll: every ${POLL_INTERVAL / 1000}s`);
  console.log(`DB: ${CHAT_DB_PATH}`);
  console.log('');

  if (!MY_USER_ID) {
    console.error('ERROR: Set MY_USER_ID in .env (your Inspector Bot user ID)');
    process.exit(1);
  }

  if (MY_PHONE === '+1XXXXXXXXXX') {
    console.error('ERROR: Set MY_PHONE_NUMBER in .env');
    process.exit(1);
  }

  openDB();

  log('Watching for messages... (Ctrl+C to stop)');
  log('Text yourself to test!');
  console.log('');

  // Poll immediately, then on interval
  poll();
  setInterval(poll, POLL_INTERVAL);
}

// Handle shutdown
process.on('SIGINT', () => {
  log('Stopping...');
  if (db) db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (db) db.close();
  process.exit(0);
});

start();
