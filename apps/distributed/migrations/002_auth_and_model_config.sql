ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug text;
UPDATE tenants
SET slug = 'tenant-' || replace(id::text, '-', '')
WHERE slug IS NULL;
ALTER TABLE tenants ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_unique_idx ON tenants (lower(slug));

CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  username text NOT NULL,
  username_normalized text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, username_normalized)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_sessions_expiry_idx ON browser_sessions (expires_at);

CREATE TABLE IF NOT EXISTS tenant_model_configs (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('mock', 'deepseek')),
  provider text NOT NULL,
  default_model text NOT NULL,
  base_url text,
  api_key_encrypted text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
