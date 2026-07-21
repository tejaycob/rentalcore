-- =====================================================================
-- RentalCore (System A) — migration 003: document storage
--
-- Applies to: ~/Developer/rentalcore, database `rentalcore`.
-- Requires 002 to have been applied first (creates the documents table).
--
-- WHY BYTEA, AND WHY THIS IS INTERIM
--
-- 002 created `documents` with a `storage_key` pointing at object storage,
-- which is the right long-term design: identity documents and signed
-- leases should live in R2/S3 behind short-lived signed URLs, not in the
-- database.
--
-- That needs credentials and a bucket that don't exist yet, and Railway's
-- container filesystem is ephemeral — anything written to disk disappears
-- on the next deploy. So uploads are stored in the database for now:
-- works locally and on Railway with zero configuration.
--
-- Migration path when object storage exists: copy file_data out to the
-- bucket, populate storage_key, then `ALTER TABLE documents DROP COLUMN
-- file_data`. The API contract does not change.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'documents') THEN
    RAISE EXCEPTION 'documents table not found — apply migration 002 first.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'documents' AND column_name = 'file_data') THEN
    RAISE EXCEPTION 'Migration 003 appears to have been applied already.';
  END IF;
END $$;

-- storage_key was NOT NULL for the object-storage design. While files live
-- in the database it has nothing meaningful to hold.
ALTER TABLE documents ALTER COLUMN storage_key DROP NOT NULL;

ALTER TABLE documents
  ADD COLUMN file_data BYTEA;

-- Exactly one of the two must be present: bytes in the database, or a key
-- pointing at the bucket. Prevents rows that reference nothing.
ALTER TABLE documents
  ADD CONSTRAINT documents_has_content
  CHECK (file_data IS NOT NULL OR storage_key IS NOT NULL);

-- 10 MB ceiling. ID scans and signed leases are well under this; the cap
-- stops someone parking a video in the database.
ALTER TABLE documents
  ADD CONSTRAINT documents_size_limit
  CHECK (file_data IS NULL OR octet_length(file_data) <= 10485760);

COMMENT ON COLUMN documents.file_data IS
  'INTERIM: file bytes stored in-database because no object storage is configured yet. Max 10MB. Migrate to storage_key + R2/S3 when available.';

COMMIT;
