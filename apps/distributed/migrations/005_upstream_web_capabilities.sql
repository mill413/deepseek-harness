CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  namespace text NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9-]*$'),
  section jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(section) = 'object'),
  revision bigint NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespace)
);

CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^[A-Z][A-Z0-9_]*$'),
  value_encrypted text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reference)
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_preset text NOT NULL DEFAULT 'standard';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_preset text NOT NULL DEFAULT 'danger-full-access';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id uuid;

CREATE TABLE IF NOT EXISTS tenant_agent_presets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name text,
  description text,
  content text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS session_goals (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  objective text NOT NULL,
  max_rounds integer,
  phase text NOT NULL DEFAULT 'active' CHECK (phase IN ('active', 'paused', 'blocked', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_attachments (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  id uuid NOT NULL,
  media_type text NOT NULL,
  name text,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_message_feedback (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  message_id text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('positive', 'negative')),
  note text,
  version uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, message_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);
