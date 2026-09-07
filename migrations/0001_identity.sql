CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug varchar(63) NOT NULL,
  name varchar(120) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_uq ON tenants(slug);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_tenant_id_uq ON tenants(id);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  username varchar(64) NOT NULL,
  display_name varchar(120) NOT NULL,
  role varchar(16) NOT NULL DEFAULT 'user',
  status varchar(16) NOT NULL DEFAULT 'active',
  password_hash text NOT NULL,
  password_version integer NOT NULL DEFAULT 1,
  restrict_public_groups boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9._-]+$'),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'user')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_password_version_check CHECK (password_version > 0),
  CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT users_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT users_tenant_username_uq UNIQUE (tenant_id, username)
);
CREATE INDEX IF NOT EXISTS users_tenant_created_idx ON users(tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  description varchar(1000) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'active',
  is_exclusive boolean NOT NULL DEFAULT false,
  daily_units_per_user bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT groups_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT groups_daily_units_check CHECK (daily_units_per_user BETWEEN 0 AND 1000000000),
  CONSTRAINT groups_revision_check CHECK (revision > 0),
  CONSTRAINT groups_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT groups_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_active_name_uq ON groups(tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS groups_tenant_created_idx ON groups(tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS user_allowed_groups (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  group_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, user_id, group_id),
  CONSTRAINT user_allowed_groups_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_allowed_groups_group_fk FOREIGN KEY (tenant_id, group_id) REFERENCES groups(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_allowed_groups_group_idx ON user_allowed_groups(tenant_id, group_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  group_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  token_hash bytea NOT NULL,
  prefix varchar(20) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  quota_units bigint NOT NULL DEFAULT 0,
  quota_epoch integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  deleted_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT api_keys_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT api_keys_prefix_format CHECK (prefix ~ '^nbc_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT api_keys_quota_check CHECK (quota_units BETWEEN 0 AND 1000000000),
  CONSTRAINT api_keys_quota_epoch_check CHECK (quota_epoch > 0),
  CONSTRAINT api_keys_revision_check CHECK (revision > 0),
  CONSTRAINT api_keys_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT api_keys_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT api_keys_group_fk FOREIGN KEY (tenant_id, group_id) REFERENCES groups(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT api_keys_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_token_hash_uq ON api_keys(token_hash);
CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(tenant_id, user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  csrf_hash bytea NOT NULL,
  password_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_csrf_hash_len CHECK (octet_length(csrf_hash) = 32),
  CONSTRAINT sessions_password_version_check CHECK (password_version > 0),
  CONSTRAINT sessions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT sessions_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sessions_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uq ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS auth_rate_buckets (
  scope varchar(24) NOT NULL,
  subject_hash bytea NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, subject_hash, window_start),
  CONSTRAINT auth_rate_subject_hash_len CHECK (octet_length(subject_hash) = 32),
  CONSTRAINT auth_rate_count_check CHECK (count >= 0)
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry_idx ON auth_rate_buckets(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_user_id uuid,
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id uuid,
  request_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_action_check CHECK (action IN ('bootstrap.admin.create','auth.logout','user.create','user.update','user.allowed_groups.replace','user.password.reset','user.password.reset.offline','group.create','group.update','group.delete','key.create','key.update','key.delete')),
  CONSTRAINT audit_target_type_check CHECK (target_type IN ('user','group','api_key','session','tenant')),
  CONSTRAINT audit_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT audit_events_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events(tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION nbcloud_bump_tenant_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant_key uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    tenant_key := OLD.tenant_id;
  ELSE
    tenant_key := NEW.tenant_id;
  END IF;
  UPDATE tenants SET revision = revision + 1, updated_at = now() WHERE id = tenant_key;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_bump_tenant_revision ON users;
CREATE TRIGGER users_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
DROP TRIGGER IF EXISTS groups_bump_tenant_revision ON groups;
CREATE TRIGGER groups_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON groups FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
DROP TRIGGER IF EXISTS keys_bump_tenant_revision ON api_keys;
CREATE TRIGGER keys_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON api_keys FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
DROP TRIGGER IF EXISTS membership_bump_tenant_revision ON user_allowed_groups;
CREATE TRIGGER membership_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON user_allowed_groups FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
