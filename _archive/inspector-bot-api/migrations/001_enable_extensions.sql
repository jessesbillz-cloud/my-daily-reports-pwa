-- =============================================
-- Inspector Bot - Migration 001
-- Enable required extensions
-- =============================================

-- Vector similarity search for RAG
CREATE EXTENSION IF NOT EXISTS vector;

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Full text search improvements
CREATE EXTENSION IF NOT EXISTS pg_trgm;
