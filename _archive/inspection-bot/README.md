# Inspection Bot

WhatsApp-powered daily report automation for construction inspectors.

## Features

- 📱 Send inspection notes via WhatsApp (works with Meta Ray-Ban glasses)
- 📝 Automatically updates Word document daily reports
- 📅 Updates dates to today
- 📷 Adds photos as separate pages with headers/footers
- 💾 Creates backups before editing
- 🔍 Logs all activity

## Prerequisites

- macOS (tested on Sonoma 14.8.3)
- Node.js v24+ 
- Python 3 with `python-docx` package
- Twilio account (free sandbox for testing)
- Anthropic API key

## Setup

### 1. Install Python dependencies

```bash
pip install python-docx --break-system-packages
```

### 2. Install Node.js dependencies

```bash
cd ~/inspection-bot
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
nano .env
```

Required values:
- `ANTHROPIC_API_KEY` - From console.anthropic.com
- `TWILIO_ACCOUNT_SID` - From twilio.com/console
- `TWILIO_AUTH_TOKEN` - From twilio.com/console
- `TWILIO_WHATSAPP_NUMBER` - Twilio sandbox number (e.g., whatsapp:+14155238886)
- `YOUR_WHATSAPP_NUMBER` - Your phone number (e.g., whatsapp:+15551234567)
- `DOCS_PATH` - Path to inspections folder (default: /Users/jessesaltzman/Documents/Inspections)

### 4. Verify folder structure

Ensure your inspection folders exist with at least one template DR in each:

```
~/Documents/Inspections/
├── Oceanside_District_Office/
│   └── DR_01__Oceanside_District_Office_Jan_16_2026.docx (template)
├── CSUSM_ISE_Building/
│   └── DR_01__CSUSM_ISE_Jan_16_2026.docx (template)
└── Woodland_Park_Mod/
    └── DR_01__Woodland_Park_MS_Mod_Jan_16_2026.docx (template)
```

## Usage

### Start the bot

```bash
npm start
```

You should see:
```
[2:30 PM] 🚀 Inspection Bot Started
[2:30 PM] Checking WhatsApp every 5 minutes
[2:30 PM] Projects configured: oceanside, hunter hall, woodland park
```

### Send inspection notes via WhatsApp

Format: `[Project]: [Notes]`

Examples:
```
Hunter Hall: Foundation complete, no cracks

Oceanside: Electrical panel installed on north wall

Woodland Park: Framing inspection passed
```

With photos:
```
Hunter Hall: Foundation complete

[Attach 1-3 photos]
```

### Stop the bot

Press `Ctrl+C` or:
```bash
pm2 stop inspection-bot
```

## Auto-Start on Boot

To have the bot start automatically when your MacBook boots:

```bash
# Start once manually first
npm start

# Then set up PM2
pm2 start server.js --name inspection-bot
pm2 startup
pm2 save
```

Now it will restart automatically after reboots.

## Configuration

Edit `config.json` to:
- Add new projects
- Change polling interval
- Adjust date formats
- Modify notes locations

## Troubleshooting

### "No template found"
- Ensure each project folder has at least one DR file
- The bot uses the most recent DR as a template for new ones

### "Can't find project folder"
- Check `DOCS_PATH` in `.env`
- Verify folder names match `config.json`

### Python errors
- Ensure `python-docx` is installed: `pip install python-docx --break-system-packages`
- Check Python version: `python3 --version` (should be 3.8+)

### WhatsApp not receiving messages
- Verify you joined the Twilio sandbox
- Check phone number format in `.env` (must include `whatsapp:` prefix)
- Confirm Twilio credentials are correct

### Dates not updating
- Check date format in `config.json` matches your template
- Verify date locations (table/row/cell indices)

## Log Files

View logs in real-time:
```bash
pm2 logs inspection-bot
```

Or check the terminal output when running with `npm start`.

## Costs

- **Anthropic Claude API**: ~$0.01 per message
- **Twilio WhatsApp**: Free (sandbox) or $0.0075 per message (production)
- **Total**: ~$0.01 per inspection note

## Project Structure

```
inspection-bot/
├── server.js          # Main polling loop
├── claude.js          # Claude API integration
├── twilio.js          # WhatsApp/Twilio integration
├── documents.js       # Word document manipulation
├── config.json        # Project configurations
├── .env               # API keys (not in git)
└── package.json       # Dependencies
```

## Support

For issues or questions, check the logs first:
- Terminal output (if running with `npm start`)
- PM2 logs (if running with PM2)

Common issues are usually:
1. Wrong API keys in `.env`
2. Missing Python dependencies
3. Incorrect folder paths
4. Template DR files missing

---

Built by Jesse Saltzman - 2026
