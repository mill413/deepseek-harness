CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  owner_user_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'failed')),
  header jsonb,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS session_events (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  seq bigint NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, seq),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_commands (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  session_id uuid NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  worker_id text,
  final_text text,
  error jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 0,
  next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_commands_dispatch_idx ON agent_commands (next_dispatch_at, created_at) WHERE status = 'queued' AND dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_commands_session_idx ON agent_commands (tenant_id, session_id, created_at DESC);
