-- Optional pgvector support for knowledge chunks. ADDITIVE and SAFE WHEN UNAVAILABLE:
-- if the `vector` extension is not installable (or privileges are missing) this migration
-- succeeds as a no-op and retrieval keeps using the JSON-embedding / keyword paths.
-- The column is intentionally not modelled in schema.prisma (Prisma has no native vector
-- type); it is read/written only through guarded raw SQL in KnowledgeVectorStore.
-- Rollback: DROP INDEX IF EXISTS "KnowledgeChunk_embeddingVec_hnsw";
--           ALTER TABLE "KnowledgeChunk" DROP COLUMN IF EXISTS "embeddingVec";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS "embeddingVec" vector(1536);
      CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embeddingVec_hnsw"
        ON "KnowledgeChunk" USING hnsw ("embeddingVec" vector_cosine_ops);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pgvector setup skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'pgvector extension not available; vector column not created';
  END IF;
END
$$;
