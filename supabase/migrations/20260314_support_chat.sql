-- Support chat system for live customer support
-- Conversations hold metadata, messages hold the actual chat

CREATE TABLE IF NOT EXISTS support_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  guest_name TEXT,
  guest_email TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user','agent')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sm_conv ON support_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_sc_status ON support_conversations(status);
CREATE INDEX IF NOT EXISTS idx_sc_updated ON support_conversations(updated_at DESC);

-- RLS
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Users can see their own conversations (or all if no user_id — anonymous)
CREATE POLICY "Users read own conversations" ON support_conversations
  FOR SELECT USING (
    user_id = auth.uid()
    OR user_id IS NULL
  );

-- Users can create conversations
CREATE POLICY "Users create conversations" ON support_conversations
  FOR INSERT WITH CHECK (true);

-- Users can update their own conversations
CREATE POLICY "Users update own conversations" ON support_conversations
  FOR UPDATE USING (user_id = auth.uid() OR user_id IS NULL);

-- Messages: users can read messages in their conversations
CREATE POLICY "Users read own messages" ON support_messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT id FROM support_conversations
      WHERE user_id = auth.uid() OR user_id IS NULL
    )
  );

-- Users can insert messages in their conversations
CREATE POLICY "Users insert messages" ON support_messages
  FOR INSERT WITH CHECK (true);

-- Support agents table — emails that can access all conversations
CREATE TABLE IF NOT EXISTS support_agents (
  email TEXT PRIMARY KEY
);
INSERT INTO support_agents (email) VALUES ('jessesbillz@gmail.com') ON CONFLICT DO NOTHING;
INSERT INTO support_agents (email) VALUES ('rachellegaciasquidasol@gmail.com') ON CONFLICT DO NOTHING;

-- Agents can see ALL conversations
CREATE POLICY "Agents read all conversations" ON support_conversations
  FOR SELECT USING (
    auth.jwt()->>'email' IN (SELECT email FROM support_agents)
  );

-- Agents can update ALL conversations (resolve, close, reopen)
CREATE POLICY "Agents update all conversations" ON support_conversations
  FOR UPDATE USING (
    auth.jwt()->>'email' IN (SELECT email FROM support_agents)
  );

-- Agents can read ALL messages
CREATE POLICY "Agents read all messages" ON support_messages
  FOR SELECT USING (
    auth.jwt()->>'email' IN (SELECT email FROM support_agents)
  );

-- Agents can insert messages in any conversation
CREATE POLICY "Agents insert messages" ON support_messages
  FOR INSERT WITH CHECK (
    auth.jwt()->>'email' IN (SELECT email FROM support_agents)
  );

-- Enable realtime for live chat
ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE support_conversations;

-- Auto-update updated_at on conversation when new message arrives
CREATE OR REPLACE FUNCTION update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE support_conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_conv_ts
  AFTER INSERT ON support_messages
  FOR EACH ROW EXECUTE FUNCTION update_conversation_timestamp();
