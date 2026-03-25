-- =============================================
-- Inspector Bot - Migration 003
-- Schedule, inspections, checklists
-- =============================================

-- Construction schedule items (imported from P6, MS Project, Excel, etc.)
CREATE TABLE IF NOT EXISTS schedule_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Schedule data
  activity_id TEXT,
  activity_name TEXT NOT NULL,
  -- CSI division mapping (auto-detected from activity name)
  csi_division TEXT,
  csi_section TEXT,
  -- Dates
  start_date DATE,
  finish_date DATE,
  actual_start DATE,
  actual_finish DATE,
  duration_days INTEGER,
  -- Progress
  percent_complete NUMERIC(5,2) DEFAULT 0,
  -- Relationships
  predecessor_ids UUID[],
  -- What trade/discipline
  trade TEXT,
  -- Location in building
  location TEXT,
  grid_lines TEXT[],
  floor_level TEXT,
  -- Status
  status TEXT DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'completed', 'delayed', 'on_hold'
  )),
  -- Whether inspector wants to track this item
  tracked BOOLEAN DEFAULT true,
  -- Inspector notes/preferences
  notes TEXT,
  -- Raw import data
  raw_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedule_project ON schedule_items(project_id);
CREATE INDEX idx_schedule_dates ON schedule_items(start_date, finish_date);
CREATE INDEX idx_schedule_trade ON schedule_items(trade);
CREATE INDEX idx_schedule_status ON schedule_items(status);
CREATE INDEX idx_schedule_tracked ON schedule_items(tracked);

-- Inspections (generated from schedule or manually created)
CREATE TABLE IF NOT EXISTS inspections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES bot_users(id),
  -- Link to schedule item that triggered this
  schedule_item_id UUID REFERENCES schedule_items(id),
  -- Inspection details
  inspection_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  -- When
  scheduled_date DATE NOT NULL,
  scheduled_time TIME,
  -- Where
  location TEXT,
  grid_lines TEXT[],
  floor_level TEXT,
  -- Status
  status TEXT DEFAULT 'upcoming' CHECK (status IN (
    'suggested', 'upcoming', 'in_progress', 'completed', 'cancelled', 'deferred'
  )),
  -- Results (after completion)
  result TEXT CHECK (result IN ('pass', 'fail', 'conditional', 'deferred')),
  result_notes TEXT,
  -- Photos taken during inspection
  photo_ids UUID[],
  -- Auto-generated daily report text
  daily_report_text TEXT,
  -- Notification tracking
  reminder_sent BOOLEAN DEFAULT false,
  prep_sent BOOLEAN DEFAULT false,
  -- Future MDR integration
  mdr_report_id UUID,
  mdr_request_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inspections_project ON inspections(project_id);
CREATE INDEX idx_inspections_date ON inspections(scheduled_date);
CREATE INDEX idx_inspections_status ON inspections(status);
CREATE INDEX idx_inspections_schedule ON inspections(schedule_item_id);

-- QA/QC Checklists (auto-generated from spec for each inspection)
CREATE TABLE IF NOT EXISTS checklist_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- What this checklist is for
  inspection_type TEXT NOT NULL,
  trade TEXT,
  title TEXT NOT NULL,
  -- Checklist items as JSONB array
  -- Each item: { "item": "Verify floor drain brand matches spec", "spec_ref": "22 40 00",
  --              "plan_ref": "P2.1", "rfi_ref": "RFI-225", "submittal_ref": "SUB-112",
  --              "code_ref": "CBC 890.1", "required": true }
  items JSONB NOT NULL DEFAULT '[]',
  -- Source chunks that generated this checklist
  source_chunk_ids UUID[],
  -- Version tracking (regenerated when docs update)
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_checklists_project ON checklist_templates(project_id);
CREATE INDEX idx_checklists_type ON checklist_templates(inspection_type);

-- Checklist instances (linked to actual inspections)
CREATE TABLE IF NOT EXISTS checklist_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES checklist_templates(id),
  -- Results per item: { "item_index": 0, "status": "pass"|"fail"|"na"|"deferred",
  --                      "notes": "Zurn 700 installed per RFI 225", "photo_id": "..." }
  results JSONB NOT NULL DEFAULT '[]',
  -- Overall
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_checklist_results_inspection ON checklist_results(inspection_id);

-- Inspection prep packages (auto-assembled documents for each inspection)
CREATE TABLE IF NOT EXISTS inspection_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Relevant documents pulled for this inspection
  -- Each: { "document_id": "...", "title": "RFI 225 - Floor Drain Substitution",
  --          "doc_category": "rfi", "page_numbers": [1,2], "relevance_score": 0.95 }
  relevant_documents JSONB NOT NULL DEFAULT '[]',
  -- Relevant spec sections
  spec_sections JSONB NOT NULL DEFAULT '[]',
  -- Relevant plan sheets
  plan_sheets JSONB NOT NULL DEFAULT '[]',
  -- Relevant RFIs
  rfis JSONB NOT NULL DEFAULT '[]',
  -- Relevant submittals
  submittals JSONB NOT NULL DEFAULT '[]',
  -- Summary generated by AI
  ai_summary TEXT,
  -- Key things to check (AI-generated from spec + RFIs + submittals)
  key_items JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_packages_inspection ON inspection_packages(inspection_id);
