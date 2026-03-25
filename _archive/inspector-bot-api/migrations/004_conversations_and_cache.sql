-- =============================================
-- Inspector Bot - Migration 004
-- Conversations, messages, query cache
-- =============================================

-- Bot conversations (chat sessions)
CREATE TABLE IF NOT EXISTS bot_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Channel: web, sms, whatsapp
  channel TEXT DEFAULT 'web',
  -- Context: what the user was doing when they started chatting
  context JSONB DEFAULT '{}',
  -- Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_user ON bot_conversations(user_id);
CREATE INDEX idx_conversations_project ON bot_conversations(project_id);

-- Bot messages
CREATE TABLE IF NOT EXISTS bot_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,
  -- Who sent it
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  -- Message content
  content TEXT NOT NULL,
  -- Source citations (which chunks were used to answer)
  -- Each: { "chunk_id": "...", "document_title": "RFI 225", "page": 3,
  --          "relevance": 0.94, "snippet": "..." }
  citations JSONB DEFAULT '[]',
  -- Attached images (from camera/photos)
  image_ids UUID[],
  -- AI model used
  model TEXT,
  -- Token usage for cost tracking
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  -- Processing time
  response_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON bot_messages(conversation_id);
CREATE INDEX idx_messages_role ON bot_messages(role);

-- Query cache (avoid re-processing identical questions)
CREATE TABLE IF NOT EXISTS query_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The question (normalized)
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  -- The answer
  response TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  -- Model used
  model TEXT,
  -- Invalidation: when docs change, cache is stale
  valid BOOLEAN DEFAULT true,
  -- How many times this cache entry was hit
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX idx_cache_lookup ON query_cache(project_id, query_hash) WHERE valid = true;

-- Notification log
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES bot_users(id),
  -- What triggered this notification
  inspection_id UUID REFERENCES inspections(id),
  -- Channel: imessage, email, push, web
  channel TEXT NOT NULL,
  -- Content
  subject TEXT,
  body TEXT NOT NULL,
  -- Delivery status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  sent_at TIMESTAMPTZ,
  -- External ID (for tracking)
  external_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_status ON notifications(status);

-- Photos (from field inspections)
CREATE TABLE IF NOT EXISTS inspection_photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES bot_users(id),
  inspection_id UUID REFERENCES inspections(id),
  -- Storage
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  -- AI analysis
  ai_description TEXT,
  ai_tags TEXT[],
  -- What was identified in the photo
  identified_items JSONB DEFAULT '[]',
  -- Location context
  location TEXT,
  grid_line TEXT,
  floor_level TEXT,
  -- Metadata
  taken_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_photos_project ON inspection_photos(project_id);
CREATE INDEX idx_photos_inspection ON inspection_photos(inspection_id);
