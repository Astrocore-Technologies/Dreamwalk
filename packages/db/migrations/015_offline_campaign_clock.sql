-- Relative clocks prevent offline wall time from resolving rounds or expiring mock decisions.
ALTER TABLE game_campaigns ADD COLUMN runtime_clock jsonb NOT NULL DEFAULT '{"paused":true,"capturedAtMs":0,"rounds":{},"jobs":{}}';
