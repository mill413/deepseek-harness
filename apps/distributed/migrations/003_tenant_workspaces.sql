CREATE TABLE IF NOT EXISTS tenant_workspaces (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  path text NOT NULL,
  title text NOT NULL,
  sort_order bigint NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, path)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_workspaces_default_unique_idx
  ON tenant_workspaces (tenant_id) WHERE is_default;

INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order, is_default)
SELECT t.id, gen_random_uuid(), '/workspace', 'Default', 0, true
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_workspaces w WHERE w.tenant_id = t.id AND w.is_default
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_order bigint NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

UPDATE sessions s
SET workspace_id = w.id,
    workspace_order = -floor(extract(epoch FROM s.created_at) * 1000)::bigint
FROM tenant_workspaces w
WHERE w.tenant_id = s.tenant_id AND w.is_default AND s.workspace_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_tenant_workspace_fk'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_tenant_workspace_fk
      FOREIGN KEY (tenant_id, workspace_id)
      REFERENCES tenant_workspaces(tenant_id, id)
      ON DELETE SET NULL (workspace_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sessions_workspace_idx
  ON sessions (tenant_id, workspace_id, workspace_order, created_at);
