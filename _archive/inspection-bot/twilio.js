const twilio = require('twilio');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const TO_NUMBER = process.env.YOUR_WHATSAPP_NUMBER;

/**
 * Get new WhatsApp messages since lastTimestamp
 */
async function getNewMessages(lastTimestamp) {
  try {
    const messages = await client.messages.list({
      from: TO_NUMBER, // Messages FROM your number
      to: FROM_NUMBER, // TO Twilio's number
      dateSentAfter: lastTimestamp,
      limit: 20
    });
    
    return messages;
  } catch (error) {
    console.error('Error fetching messages:', error);
    throw error;
  }
}

/**
 * Send WhatsApp message
 */
async function sendMessage(body) {
  try {
    const message = await client.messages.create({
      from: FROM_NUMBER,
      to: TO_NUMBER,
      body: body
    });
    
    return message;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

/**
 * Download media (photos) from message
 */
async function downloadMedia(message) {
  const photos = [];
  
  for (let i = 0; i < parseInt(message.numMedia); i++) {
    try {
      const mediaUrl = message.media[i]?.url || message.mediaUrl0; // Handle different Twilio response formats
      
      if (!mediaUrl) continue;
      
      // Download photo
      const photoBuffer = await downloadFile(mediaUrl);
      photos.push(photoBuffer);
      
    } catch (error) {
      console.error(`Error downloading media ${i}:`, error);
    }
  }
  
  return photos;
}

/**
 * Download file from URL with Twilio auth
 */
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');
    
    const options = {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    };
    
    https.get(url, options, (response) => {
      const chunks = [];
      
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  getNewMessages,
  sendMessage,
  downloadMedia
};
