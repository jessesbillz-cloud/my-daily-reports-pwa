// Inspector Bot API Configuration
// All env vars with sensible defaults

export const config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CORS_ORIGINS: process.env.CORS_ORIGINS || '*',

  // Supabase (Inspector Bot's own project)
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,

  // Anthropic Claude
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // OpenAI (embeddings)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,

  // OpenDataLoader microservice
  OPENDATALOADER_URL: process.env.OPENDATALOADER_URL || 'https://opendataloader-service-production.up.railway.app',

  // iMessage (local Mac only)
  MY_PHONE_NUMBER: process.env.MY_PHONE_NUMBER,
  MY_USER_ID: process.env.MY_USER_ID,

  // Embedding config
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: 1536,

  // Chunking config
  CHUNK_SIZE: 1000,        // tokens per chunk
  CHUNK_OVERLAP: 200,      // overlap between chunks

  // RAG config
  RAG_MATCH_THRESHOLD: 0.7,
  RAG_MATCH_COUNT: 10,

  // AI model tiers
  AI_TIER_1: 'claude-haiku-4-5-20251001',   // Quick lookups, classifications
  AI_TIER_2: 'claude-sonnet-4-6',            // Standard Q&A, document analysis
  AI_TIER_3: 'claude-opus-4-6',              // Complex multi-doc reasoning

  // Future MDR integration
  MDR_SUPABASE_URL: process.env.MDR_SUPABASE_URL,
  MDR_SUPABASE_KEY: process.env.MDR_SUPABASE_KEY,
};
