BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE account_status AS ENUM ('idle','online','rate_limited','disconnected','suspended','session_expired');
CREATE TYPE group_status AS ENUM ('active','unreachable','left');
CREATE TYPE group_role AS ENUM ('creator','admin','member');
CREATE TYPE delivery_status AS ENUM ('queued','accepted','sent','failed','unknown','cancelled');
CREATE TYPE work_status AS ENUM ('running','finished','failed');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','viewer'))
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL,
  current_refresh_hash text NOT NULL,
  previous_refresh_hash text,
  generation integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_family_idx ON auth_sessions(family_id);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  status account_status NOT NULL DEFAULT 'idle',
  platform_user_id text UNIQUE,
  rate_limited_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id uuid PRIMARY KEY,
  gateway_group_id text UNIQUE,
  status group_status NOT NULL DEFAULT 'active',
  creator_account_id text NOT NULL REFERENCES accounts(id),
  agent_enabled boolean NOT NULL DEFAULT false,
  auto_kick_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  account_id text REFERENCES accounts(id),
  platform_user_id text NOT NULL,
  role group_role NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, platform_user_id),
  UNIQUE (group_id, account_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  msg_id text,
  client_msg_id text,
  sender_platform_user_id text,
  account_id text REFERENCES accounts(id),
  is_own boolean NOT NULL DEFAULT false,
  text text NOT NULL,
  sent_at timestamptz NOT NULL,
  delivery_status delivery_status,
  fail_code text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count <= 2),
  last_attempt_at timestamptz,
  unknown_since timestamptz,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, msg_id),
  UNIQUE (client_msg_id),
  CHECK ((delivery_status IN ('failed','cancelled')) = (fail_code IS NOT NULL))
);
CREATE INDEX messages_timeline_idx ON messages(group_id, sent_at DESC, id DESC);
CREATE INDEX messages_dispatch_idx ON messages(next_attempt_at) WHERE delivery_status IN ('queued','unknown');

CREATE TABLE gateway_events (
  event_id bigint PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz
);

CREATE TABLE gateway_checkpoints (
  stream text PRIMARY KEY,
  contiguous_event_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gateway_checkpoints(stream) VALUES ('main');

CREATE TABLE frontend_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('create_group','leave_all')),
  status work_status NOT NULL DEFAULT 'running',
  group_id uuid REFERENCES groups(id),
  input jsonb NOT NULL,
  state jsonb NOT NULL DEFAULT '{}',
  errors jsonb NOT NULL DEFAULT '[]',
  lease_owner text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE agent_run_status AS ENUM ('running','finished','failed','blocked','cancelled');
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  status agent_run_status NOT NULL DEFAULT 'running',
  end_reason text,
  summary text,
  trigger_messages jsonb NOT NULL,
  messages jsonb NOT NULL,
  pending_trigger_messages jsonb NOT NULL DEFAULT '[]',
  step_count integer NOT NULL DEFAULT 0,
  consecutive_protocol_errors integer NOT NULL DEFAULT 0,
  elapsed_ms bigint NOT NULL DEFAULT 0,
  active_since timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_owner text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_running_agent_per_group ON agent_runs(group_id) WHERE status = 'running';

CREATE TABLE agent_steps (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  step_index integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  tool_use_id text,
  name text,
  input jsonb,
  result_summary text NOT NULL DEFAULT '',
  is_error boolean NOT NULL DEFAULT false,
  error_code text,
  audit_verdict text,
  raw_response text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);
CREATE UNIQUE INDEX unique_agent_tool_use_id ON agent_steps(run_id,tool_use_id) WHERE tool_use_id IS NOT NULL;

CREATE TABLE agent_tool_effects (
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  idempotency_key text NOT NULL,
  tool_use_id text NOT NULL,
  kind text NOT NULL,
  phase text NOT NULL,
  message_id uuid REFERENCES messages(id),
  target_platform_user_id text,
  result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, idempotency_key)
);

CREATE TABLE sequences (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  steps jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE sequence_run_status AS ENUM ('running','finished','failed','stopped');
CREATE TYPE sequence_step_status AS ENUM ('pending','accepted','sent','skipped','failed');
CREATE TABLE sequence_runs (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  sequence_id uuid NOT NULL REFERENCES sequences(id),
  status sequence_run_status NOT NULL DEFAULT 'running',
  current_step_index integer NOT NULL DEFAULT 1,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_running_sequence_per_group ON sequence_runs(group_id) WHERE status = 'running';

CREATE TABLE sequence_run_steps (
  run_id uuid NOT NULL REFERENCES sequence_runs(id),
  step_index integer NOT NULL,
  account_role text NOT NULL CHECK (account_role IN ('admin','member')),
  text_template text NOT NULL,
  resolved_text text NOT NULL,
  delay_seconds integer NOT NULL CHECK (delay_seconds >= 0),
  status sequence_step_status NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  client_msg_id text,
  resolved_vars jsonb NOT NULL,
  var_sources jsonb NOT NULL,
  PRIMARY KEY (run_id, step_index)
);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
