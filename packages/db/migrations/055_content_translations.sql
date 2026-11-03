-- Derived visible-text cache. No public read endpoint, no source prompts or credentials.
-- Cache lookup always follows the original resource's authorization and projection.
CREATE TABLE content_translations (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  adventure_id uuid REFERENCES adventures(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES game_campaigns(id) ON DELETE CASCADE,
  viewer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('uk','en','ru')),
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','ready','failed')),
  translated_text text CHECK (length(translated_text) BETWEEN 1 AND 12000),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (num_nonnulls(adventure_id,campaign_id)=1),
  CHECK (campaign_id IS NULL OR viewer_id IS NOT NULL),
  CHECK ((status='ready')=(translated_text IS NOT NULL))
);
CREATE INDEX content_translations_adventure_idx ON content_translations(adventure_id);
CREATE INDEX content_translations_campaign_idx ON content_translations(campaign_id);
CREATE INDEX content_translations_viewer_idx ON content_translations(viewer_id);
