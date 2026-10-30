-- Defaults for existing author drafts. Published version rows remain byte-for-byte immutable.
UPDATE adventures SET data=data || jsonb_build_object(
 'sourceLanguage',COALESCE(data->'sourceLanguage','"ru"'::jsonb),
 'sourceRevision',COALESCE(data->'sourceRevision','1'::jsonb),
 'translations',COALESCE(data->'translations','{}'::jsonb)
);
