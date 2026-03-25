-- =============================================
-- Inspector Bot - Migration 007
-- Active sessions (project context switching)
-- Daily reports (note accumulation)
-- =============================================

-- Active sessions: tracks which project the inspector is currently at
-- "I'm at Woodland Park" → creates active session
-- "Heading to Hunter Hall" → closes WP session, opens HH session
CREATE TABLE IF NOT EXISTS active_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  -- Timestamps
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  -- Running accumulation for today's work at this project
  notes_today JSONB DEFAULT '[]',
  photos_today UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_active ON active_sessions(user_id, status) WHERE status = 'active';
CREATE INDEX idx_sessions_project ON active_sessions(project_id);
CREATE INDEX idx_sessions_date ON active_sessions(started_at);

-- Daily reports: one per project per day, notes accumulate throughout the day
-- When integrated with MDR, this maps to the MDR reports table
CREATE TABLE IF NOT EXISTS daily_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES bot_users(id),
  -- Report identity
  report_date DATE NOT NULL,
  report_number INTEGER NOT NULL,
  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'submitted', 'final')),
  -- Accumulated notes (JSONB array)
  -- Each: { "text": "...", "timestamp": "2:30 PM", "result": "pass"|"fail"|null, "added_at": "..." }
  notes JSONB DEFAULT '[]',
  -- Photo references
  photos UUID[] DEFAULT '{}',
  -- Weather (can be auto-fetched or manual)
  weather JSONB,
  -- AI-generated summary of the day's work
  ai_summary TEXT,
  -- Future MDR integration
  mdr_report_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_daily_reports_unique ON daily_reports(project_id, report_date);
CREATE INDEX idx_daily_reports_user ON daily_reports(user_id);
CREATE INDEX idx_daily_reports_date ON daily_reports(report_date);

-- RLS
ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own sessions" ON active_sessions
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "Users manage own daily reports" ON daily_reports
  FOR ALL USING (user_id = auth.uid());

-- Auto-update trigger
CREATE TRIGGER trg_daily_reports_updated ON daily_reports
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
