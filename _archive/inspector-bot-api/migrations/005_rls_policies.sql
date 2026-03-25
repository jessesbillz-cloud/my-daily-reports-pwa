-- =============================================
-- Inspector Bot - Migration 005
-- Row Level Security policies
-- =============================================

-- Enable RLS on all tables
ALTER TABLE bot_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_photos ENABLE ROW LEVEL SECURITY;

-- bot_users: users can read/update their own profile
CREATE POLICY "Users read own profile" ON bot_users
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "Users update own profile" ON bot_users
  FOR UPDATE USING (id = auth.uid());

-- projects: users see their own projects
CREATE POLICY "Users manage own projects" ON projects
  FOR ALL USING (user_id = auth.uid());

-- project_documents: users see docs in their projects
CREATE POLICY "Users manage project docs" ON project_documents
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- document_chunks: same as docs
CREATE POLICY "Users read project chunks" ON document_chunks
  FOR SELECT USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- document_embeddings: same
CREATE POLICY "Users read project embeddings" ON document_embeddings
  FOR SELECT USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- schedule_items: users manage schedule in their projects
CREATE POLICY "Users manage project schedule" ON schedule_items
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- inspections: users manage inspections in their projects
CREATE POLICY "Users manage inspections" ON inspections
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- checklist_templates: project-scoped
CREATE POLICY "Users read project checklists" ON checklist_templates
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- checklist_results: via inspection ownership
CREATE POLICY "Users manage checklist results" ON checklist_results
  FOR ALL USING (inspection_id IN (
    SELECT id FROM inspections WHERE project_id IN (
      SELECT id FROM projects WHERE user_id = auth.uid()
    )
  ));

-- inspection_packages: via inspection ownership
CREATE POLICY "Users read inspection packages" ON inspection_packages
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- bot_conversations: users see their own
CREATE POLICY "Users manage own conversations" ON bot_conversations
  FOR ALL USING (user_id = auth.uid());

-- bot_messages: via conversation ownership
CREATE POLICY "Users read own messages" ON bot_messages
  FOR ALL USING (conversation_id IN (
    SELECT id FROM bot_conversations WHERE user_id = auth.uid()
  ));

-- query_cache: project-scoped
CREATE POLICY "Users read project cache" ON query_cache
  FOR SELECT USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- notifications: users see their own
CREATE POLICY "Users read own notifications" ON notifications
  FOR SELECT USING (user_id = auth.uid());

-- inspection_photos: project-scoped
CREATE POLICY "Users manage project photos" ON inspection_photos
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- Service role bypass (for the API server using service key)
-- The API server uses the service_role key which bypasses RLS automatically
