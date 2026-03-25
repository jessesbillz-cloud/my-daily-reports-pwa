# Inspector Bot API - Deployment Guide

## Architecture

Two pieces run together:
1. **Inspector Bot API** (Railway) — handles document ingestion, RAG queries, schedule analysis
2. **iMessage Watcher** (your Mac) — reads your texts, sends them to the API, replies via iMessage

## Step 1: Create a NEW Supabase Project

Go to: https://supabase.com/dashboard/projects

Create a new project called "inspector-bot" (NOT your MDR project).

Once created, grab these from Settings → API:
- Project URL
- service_role key (secret)
- anon key (public)

## Step 2: Run Database Migrations

In your Supabase SQL Editor, run each file in order:

1. `migrations/001_enable_extensions.sql`
2. `migrations/002_core_tables.sql`
3. `migrations/003_schedule_and_inspections.sql`
4. `migrations/004_conversations_and_cache.sql`
5. `migrations/005_rls_policies.sql`
6. `migrations/006_functions.sql`
7. `migrations/007_sessions_and_daily_reports.sql`

Copy-paste each one into the SQL editor and click "Run".

## Step 3: Create Storage Bucket

In Supabase Dashboard → Storage, create a new bucket:
- Name: `project-documents`
- Public: No (private)
- File size limit: 100MB

## Step 4: Create GitHub Repo

```bash
cd ~/inspector-bot-api
git init
git add .
git commit -m "Initial commit - Inspector Bot API"
gh repo create inspector-bot-api --private --source=. --push
```

## Step 5: Get API Keys

You need:
- **Anthropic API Key**: https://console.anthropic.com/settings/keys
- **OpenAI API Key**: https://platform.openai.com/api-keys (for embeddings only)

## Step 6: Deploy API to Railway

```bash
cd ~/inspector-bot-api
railway login
railway init
railway link
```

Set environment variables:
```bash
railway variables set SUPABASE_URL=https://YOUR_PROJECT.supabase.co
railway variables set SUPABASE_SERVICE_KEY=eyJ...
railway variables set SUPABASE_ANON_KEY=eyJ...
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set OPENAI_API_KEY=sk-...
railway variables set PORT=3000
railway variables set NODE_ENV=production
```

Deploy:
```bash
railway up
```

## Step 7: Set Up iMessage Watcher (your Mac)

1. Grant Full Disk Access to Terminal:
   System Settings → Privacy & Security → Full Disk Access → Add Terminal

2. Create your `.env` file:
```bash
cd ~/inspector-bot-api
cp .env.example .env
```

3. Edit `.env` with your values:
```
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
MY_PHONE_NUMBER=+1YOURNUMBER
MY_USER_ID=your-uuid-from-bot_users-table
API_URL=https://YOUR-RAILWAY-URL.up.railway.app
```

4. Install deps and run:
```bash
npm install
npm run local
```

5. Text yourself to test! Send "I'm at Oceanside" and the bot should reply.

## Step 8: Test the API

```bash
# Health check
curl https://YOUR-RAILWAY-URL.up.railway.app/health

# Upload a spec document
curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/api/documents/upload \
  -F "file=@/path/to/your/spec.pdf" \
  -F "projectId=PROJECT_ID" \
  -F "userId=USER_ID" \
  -F "docCategory=spec" \
  -F "title=Project Specifications"

# Ask a question via API
curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/api/query \
  -H "Content-Type: application/json" \
  -d '{"projectId": "PROJECT_ID", "query": "What floor drain is specified?"}'

# Or just text yourself: "what floor drain is specified?"
```

## Cost Estimates

- **Supabase Free Tier**: 500MB database, 1GB storage
- **OpenAI Embeddings**: ~$0.02 per 1M tokens (~2 cents per 1000-page spec)
- **Claude API**: Haiku ~$0.25/1M tokens, Sonnet ~$3/1M tokens
- **Railway**: $5/mo hobby plan
- **iMessage**: Free (it's your Mac)

For a single project with 1000 pages of specs + 500 submittals:
- Initial ingestion: ~$1-3 (one time)
- Per query: ~$0.01-0.05
- Monthly estimate (50 queries/day): ~$15-75/mo total
