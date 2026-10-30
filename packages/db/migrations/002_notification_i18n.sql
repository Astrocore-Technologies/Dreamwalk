ALTER TABLE notifications ADD COLUMN type text NOT NULL DEFAULT 'message';
ALTER TABLE notifications ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
