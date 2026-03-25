-- =============================================
-- Inspector Bot - Migration 006
-- Database functions for vector search & utilities
-- =============================================

-- Semantic search: find most relevant chunks for a query
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_project_id UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter_category TEXT DEFAULT NULL,
  filter_spec_section TEXT DEFAULT NULL
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  content TEXT,
  page_number INTEGER,
  section_title TEXT,
  spec_section TEXT,
  plan_sheet TEXT,
  reference_number TEXT,
  doc_category TEXT,
  document_title TEXT,
  original_filename TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id AS chunk_id,
    dc.document_id,
    dc.content,
    dc.page_number,
    dc.section_title,
    dc.spec_section,
    dc.plan_sheet,
    dc.reference_number,
    pd.doc_category,
    pd.title AS document_title,
    pd.original_filename,
    1 - (de.embedding <=> query_embedding) AS similarity
  FROM document_embeddings de
  JOIN document_chunks dc ON dc.id = de.chunk_id
  JOIN project_documents pd ON pd.id = dc.document_id
  WHERE de.project_id = match_project_id
    AND 1 - (de.embedding <=> query_embedding) > match_threshold
    AND (filter_category IS NULL OR pd.doc_category = filter_category)
    AND (filter_spec_section IS NULL OR dc.spec_section LIKE filter_spec_section || '%')
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Find related RFIs for a spec section
CREATE OR REPLACE FUNCTION find_related_rfis(
  p_project_id UUID,
  p_spec_section TEXT
)
RETURNS TABLE (
  document_id UUID,
  document_number TEXT,
  title TEXT,
  description TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pd.id AS document_id,
    pd.document_number,
    pd.title,
    pd.description
  FROM project_documents pd
  WHERE pd.project_id = p_project_id
    AND pd.doc_category = 'rfi'
    AND (
      p_spec_section = ANY(pd.spec_sections)
      OR pd.extracted_metadata->>'spec_section' LIKE p_spec_section || '%'
    )
  ORDER BY pd.document_number;
END;
$$;

-- Find related submittals for a spec section
CREATE OR REPLACE FUNCTION find_related_submittals(
  p_project_id UUID,
  p_spec_section TEXT
)
RETURNS TABLE (
  document_id UUID,
  document_number TEXT,
  title TEXT,
  description TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pd.id AS document_id,
    pd.document_number,
    pd.title,
    pd.description
  FROM project_documents pd
  WHERE pd.project_id = p_project_id
    AND pd.doc_category = 'submittal'
    AND (
      p_spec_section = ANY(pd.spec_sections)
      OR pd.extracted_metadata->>'spec_section' LIKE p_spec_section || '%'
    )
  ORDER BY pd.document_number;
END;
$$;

-- Invalidate cache when documents change
CREATE OR REPLACE FUNCTION invalidate_project_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE query_cache SET valid = false
  WHERE project_id = COALESCE(NEW.project_id, OLD.project_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invalidate_cache_on_doc_change
  AFTER INSERT OR UPDATE OR DELETE ON project_documents
  FOR EACH ROW EXECUTE FUNCTION invalidate_project_cache();

CREATE TRIGGER trg_invalidate_cache_on_chunk_change
  AFTER INSERT OR UPDATE OR DELETE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION invalidate_project_cache();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bot_users_updated ON bot_users
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated ON projects
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_documents_updated ON project_documents
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_schedule_updated ON schedule_items
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_inspections_updated ON inspections
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_checklists_updated ON checklist_templates
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_conversations_updated ON bot_conversations
  BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at();
