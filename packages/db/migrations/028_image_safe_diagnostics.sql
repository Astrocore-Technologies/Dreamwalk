-- Safe canonical provider diagnostics only. Never raw provider payloads/prompts.
ALTER TABLE image_generation_jobs ADD COLUMN safe_diagnostic jsonb;
ALTER TABLE image_generation_jobs ADD CONSTRAINT image_safe_diagnostic_bounded CHECK (
  safe_diagnostic IS NULL OR (
    jsonb_typeof(safe_diagnostic) = 'object' AND octet_length(safe_diagnostic::text) <= 2048
  )
);
