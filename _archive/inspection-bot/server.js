require('dotenv').config();
const twilio = require('./twilio');
const claude = require('./claude');
const documents = require('./documents');
const config = require('./config.json');

// Track last message timestamp to avoid reprocessing
let lastMessageTimestamp = new Date();

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
}

async function processMessage(message) {
  try {
    log(`Processing message from ${message.from}: "${message.body}"`);
    
    // Parse message with Claude
    const parsed = await claude.parseMessage(message.body);
    
    if (!parsed.project) {
      log('Could not identify project from message');
      await twilio.sendMessage('❓ Please start with project name (Oceanside, Hunter Hall, or Woodland Park)');
      return;
    }
    
    // Check if project exists
    const projectConfig = config.projects[parsed.project.toLowerCase()];
    if (!projectConfig) {
      log(`Unknown project: ${parsed.project}`);
      await twilio.sendMessage(`❓ I don't recognize "${parsed.project}". Is this a new project? (Reply with full name to add)`);
      return;
    }
    
    log(`Identified project: ${projectConfig.full_name}`);
    
    // Download photos if any
    let photos = [];
    if (message.numMedia && parseInt(message.numMedia) > 0) {
      log(`Downloading ${message.numMedia} photo(s)...`);
      photos = await twilio.downloadMedia(message);
      log(`Downloaded ${photos.length} photo(s)`);
    }
    
    // Update document
    log('Updating daily report...');
    const result = await documents.updateDailyReport(
      projectConfig,
      parsed.notes,
      photos
    );
    
    log(`✅ Updated: ${result.filename}`);
    
    // Send confirmation
    const drNumber = result.filename.match(/DR_(\d+)/)?.[1] || '?';
    await twilio.sendMessage(`✅ ${projectConfig.full_name.split(' ')[0]} DR_${drNumber}`);
    
  } catch (error) {
    log(`ERROR processing message: ${error.message}`);
    console.error(error);
    await twilio.sendMessage('⚠️ Error processing message. Check logs.');
  }
}

async function checkForMessages() {
  try {
    const messages = await twilio.getNewMessages(lastMessageTimestamp);
    
    if (messages.length === 0) {
      log('No new messages');
      return;
    }
    
    log(`Found ${messages.length} new message(s)`);
    
    for (const message of messages) {
      await processMessage(message);
      
      // Update timestamp
      const messageTime = new Date(message.dateCreated);
      if (messageTime > lastMessageTimestamp) {
        lastMessageTimestamp = messageTime;
      }
    }
    
  } catch (error) {
    log(`ERROR checking messages: ${error.message}`);
    console.error(error);
  }
}

// Main loop
async function start() {
  log('🚀 Inspection Bot Started');
  log(`Checking WhatsApp every ${config.polling_interval_minutes} minutes`);
  log(`Projects configured: ${Object.keys(config.projects).join(', ')}`);
  log('---');
  
  // Check immediately on startup
  await checkForMessages();
  
  // Then check every N minutes
  const intervalMs = config.polling_interval_minutes * 60 * 1000;
  setInterval(checkForMessages, intervalMs);
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  log('👋 Bot stopping...');
  process.exit(0);
});

// Start the bot
start().catch(error => {
  log(`FATAL ERROR: ${error.message}`);
  console.error(error);
  process.exit(1);
});
