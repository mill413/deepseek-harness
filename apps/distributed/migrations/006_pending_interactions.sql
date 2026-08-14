CREATE TABLE IF NOT EXISTS pending_interactions (
  tenant_id uuid NOT NULL,
  rpc_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('question', 'approval')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rpc_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pending_interactions_session_status
  ON pending_interactions (tenant_id, session_id, status, created_at);
