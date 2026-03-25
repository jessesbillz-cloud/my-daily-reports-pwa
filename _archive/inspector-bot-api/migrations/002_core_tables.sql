-- =============================================
-- Inspector Bot - Migration 002
-- Core tables: projects, users, documents
-- =============================================

-- Inspector Bot users (separate from MDR, but same email for future linking)
CREATE TABLE IF NOT EXISTS bot_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  phone TEXT,
  company TEXT,
  role TEXT DEFAULT 'inspector',
  preferences JSONB DEFAULT '{}',
  -- Future MDR integration: store their MDR user_id if they link accounts
  mdr_user_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects (construction jobs)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  site_address TEXT,
  project_number TEXT,
  -- DSA specific
  dsa_app_number TEXT,
  dsa_file_number TEXT,
  is_dsa BOOLEAN DEFAULT false,
  -- Project metadata
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'on_hold', 'archived')),
  settings JSONB DEFAULT '{}',
  -- Future MDR integration
  mdr_job_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_user ON projects(user_id);
CREATE INDEX idx_projects_status ON projects(status);

-- Document types: spec, plans, rfi, submittal, schedule, addendum, code, other
CREATE TABLE IF NOT EXISTS project_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES bot_users(id),
  -- Document info
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'jpg', 'png', 'heic')),
  doc_category TEXT NOT NULL CHECK (doc_category IN (
    'spec', 'plans', 'rfi', 'submittal', 'schedule',
    'addendum', 'code', 'daily_report', 'photo', 'correspondence', 'other'
  )),
  -- For RFIs and submittals, track their number
  document_number TEXT,
  title TEXT,
  description TEXT,
  -- Storage
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  page_count INTEGER,
  -- Processing status
  processing_status TEXT DEFAULT 'pending' CHECK (processing_status IN (
    'pending', 'parsing', 'chunking', 'embedding', 'ready', 'failed'
  )),
  processing_error TEXT,
  -- Metadata extracted during processing
  extracted_metadata JSONB DEFAULT '{}',
  -- Spec section references (e.g., "Division 22 - Plumbing")
  spec_sections TEXT[],
  -- Plan sheet references (e.g., ["P2.1", "P2.2"])
  plan_sheets TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_docs_project ON project_documents(project_id);
CREATE INDEX idx_docs_category ON project_documents(doc_category);
CREATE INDEX idx_docs_status ON project_documents(processing_status);
CREATE INDEX idx_docs_number ON project_documents(document_number);

-- Document chunks - parsed and split content ready for embedding
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Chunk content
  content TEXT NOT NULL,
  -- Where this chunk came from
  page_number INTEGER,
  section_title TEXT,
  -- For specs: division/section (e.g., "22 40 00" = Plumbing Fixtures)
  spec_section TEXT,
  -- For plans: sheet number (e.g., "P2.1")
  plan_sheet TEXT,
  -- For RFIs/submittals: reference number
  reference_number TEXT,
  -- Chunk ordering
  chunk_index INTEGER NOT NULL,
  -- Token count for cost tracking
  token_count INTEGER,
  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chunks_document ON document_chunks(document_id);
CREATE INDEX idx_chunks_project ON document_chunks(project_id);
CREATE INDEX idx_chunks_spec ON document_chunks(spec_section);
CREATE INDEX idx_chunks_sheet ON document_chunks(plan_sheet);

-- Vector embeddings for semantic search
CREATE TABLE IF NOT EXISTS document_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chunk_id UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- OpenAI text-embedding-3-small produces 1536 dimensions
  embedding vector(1536) NOT NULL,
  -- Model used (for future migration if we switch)
  model TEXT DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast similarity search
CREATE INDEX idx_embeddings_vector ON document_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_embeddings_project ON document_embeddings(project_id);
