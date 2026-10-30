-- User policy: two visibility choices, independent of authoring lifecycle.
ALTER TABLE adventures ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN('private','public'));
UPDATE adventures SET visibility=CASE WHEN status IN('published','pending_review') OR (status='draft' AND published_snapshot IS NOT NULL) THEN 'public' ELSE 'private' END;
ALTER TABLE adventures DROP CONSTRAINT adventures_status_check;
UPDATE adventures SET status='draft' WHERE status IN('private','unlisted');
ALTER TABLE adventures ADD CONSTRAINT adventures_status_check CHECK(status IN('draft','pending_review','published','archived'));
UPDATE adventures SET data=jsonb_set(jsonb_set(data,'{visibility}',to_jsonb(visibility)),'{status}',to_jsonb(status));
UPDATE adventures SET published_snapshot=NULL WHERE visibility='private';
UPDATE users SET settings=jsonb_set(settings,'{defaultVisibility}','"private"'::jsonb) WHERE settings->>'defaultVisibility'='unlisted';
UPDATE npcs SET data=jsonb_set(data,'{visibility}','"private"'::jsonb);
CREATE TABLE adventure_invitations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 adventure_id uuid NOT NULL REFERENCES adventures(id),
 owner_id uuid NOT NULL REFERENCES users(id),
 recipient_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','declined','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(adventure_id,recipient_id),
 CHECK(owner_id<>recipient_id)
);
CREATE INDEX invitation_recipient_status_idx ON adventure_invitations(recipient_id,status);
