CREATE TABLE studio_location_images (
 adventure_id uuid NOT NULL REFERENCES adventures(id) ON DELETE CASCADE,
 location_id text NOT NULL CHECK(length(location_id) BETWEEN 1 AND 80),
 owner_id uuid NOT NULL REFERENCES users(id),
 revision_id uuid NOT NULL REFERENCES art_asset_revisions(id) ON DELETE CASCADE,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 map_id text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(adventure_id,location_id)
);
CREATE TABLE studio_location_image_operations (
 owner_id uuid NOT NULL REFERENCES users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,operation_id)
);
