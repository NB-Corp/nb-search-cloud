-- Execution data only. Identity/group/key semantics remain in 0001.
ALTER TABLE groups ADD COLUMN default_search_lane varchar(256), ADD COLUMN default_fetch_pipeline varchar(256), ADD COLUMN presets jsonb NOT NULL DEFAULT '{}';
ALTER TABLE audit_events DROP CONSTRAINT audit_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_action_check CHECK (action IN ('bootstrap.admin.create','auth.logout','user.create','user.update','user.allowed_groups.replace','user.password.reset','user.password.reset.offline','group.create','group.update','group.delete','key.create','key.update','key.delete','provider.create','provider.update','provider.delete','lane.create','lane.update','group.capabilities.replace','key.quota.reset','job.cancel'));
ALTER TABLE audit_events DROP CONSTRAINT audit_target_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_target_type_check CHECK (target_type IN ('user','group','api_key','session','tenant','provider','lane','job'));

CREATE TABLE providers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name varchar(100) NOT NULL,
 provider_id varchar(64) NOT NULL CHECK(provider_id IN ('exa','grok-multi-agent')),
 status varchar(16) NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 current_config_id uuid, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX providers_name_uq ON providers(tenant_id,name) WHERE deleted_at IS NULL;
CREATE TABLE provider_configs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, provider_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 sdk_version varchar(128) NOT NULL, adapter_version varchar(32) NOT NULL, config_schema varchar(8) NOT NULL DEFAULT '4' CHECK(config_schema='4'),
 base_url varchar(2048) NOT NULL, options jsonb NOT NULL DEFAULT '{}',
 secret_key_id varchar(64), nonce bytea, ciphertext bytea, auth_tag bytea,
 credential_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,provider_id,id), UNIQUE(provider_id,version), UNIQUE(secret_key_id,nonce),
 FOREIGN KEY(tenant_id,provider_id) REFERENCES providers(tenant_id,id),
 CHECK((secret_key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL AND credential_updated_at IS NULL) OR
       (secret_key_id IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND ciphertext IS NOT NULL AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext)>0 AND credential_updated_at IS NOT NULL))
);
ALTER TABLE providers ADD CONSTRAINT providers_current_fk FOREIGN KEY(tenant_id,id,current_config_id) REFERENCES provider_configs(tenant_id,provider_id,id);
CREATE TABLE lanes (
 tenant_id uuid NOT NULL, id varchar(256) NOT NULL, kind varchar(8) NOT NULL CHECK(kind IN ('search','fetch')),
 provider_id uuid NOT NULL, operation_id varchar(32) NOT NULL, status varchar(16) NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 latency varchar(8) NOT NULL CHECK(latency IN ('fast','medium','slow')), cost varchar(16) NOT NULL CHECK(cost IN ('free','cheap','expensive')),
 evidence_groups jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,provider_id) REFERENCES providers(tenant_id,id)
);
CREATE TABLE group_lanes (
 tenant_id uuid NOT NULL, group_id uuid NOT NULL, lane_id varchar(256) NOT NULL,
 units_per_query integer NOT NULL DEFAULT 1 CHECK(units_per_query BETWEEN 1 AND 1000000),
 PRIMARY KEY(tenant_id,group_id,lane_id), FOREIGN KEY(tenant_id,group_id) REFERENCES groups(tenant_id,id), FOREIGN KEY(tenant_id,lane_id) REFERENCES lanes(tenant_id,id)
);
CREATE TABLE group_usage_buckets (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, group_id uuid NOT NULL, utc_day date NOT NULL,
 reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0), used_units bigint NOT NULL DEFAULT 0 CHECK(used_units>=0),
 PRIMARY KEY(tenant_id,user_id,group_id,utc_day), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,group_id) REFERENCES groups(tenant_id,id)
);
CREATE TABLE key_usage_buckets (
 tenant_id uuid NOT NULL, key_id uuid NOT NULL, epoch integer NOT NULL CHECK(epoch>0),
 reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0), used_units bigint NOT NULL DEFAULT 0 CHECK(used_units>=0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key_id,epoch), FOREIGN KEY(tenant_id,key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, group_id uuid NOT NULL, admitting_key_id uuid NOT NULL,
 kind varchar(8) NOT NULL CHECK(kind IN ('search','fetch')), delivery varchar(8) NOT NULL CHECK(delivery IN ('sync','async')),
 state varchar(16) NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
 plan_version integer NOT NULL DEFAULT 1 CHECK(plan_version=1), first_plan jsonb NOT NULL, selection jsonb NOT NULL,
 request_id varchar(128) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz, completed_at timestamptz, expires_at timestamptz, cancel_requested_at timestamptz,
 lease_owner uuid, lease_expires_at timestamptz, claim_count integer NOT NULL DEFAULT 0 CHECK(claim_count>=0), dispatch_started_at timestamptz,
 public_error jsonb, sync_envelope jsonb, purged_at timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,group_id) REFERENCES groups(tenant_id,id), FOREIGN KEY(tenant_id,admitting_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK((state IN ('queued','running') AND completed_at IS NULL AND expires_at IS NULL) OR (state IN ('succeeded','failed','cancelled') AND completed_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>=completed_at))
);
ALTER TABLE jobs ALTER COLUMN first_plan DROP NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT jobs_plan_retention CHECK(first_plan IS NOT NULL OR purged_at IS NOT NULL);
CREATE INDEX jobs_queue_idx ON jobs(state,created_at,id) WHERE state IN ('queued','running');
CREATE INDEX jobs_owner_idx ON jobs(tenant_id,user_id,kind,id);
CREATE INDEX jobs_retention_idx ON jobs(expires_at) WHERE completed_at IS NOT NULL;
-- Relational references stop historical config GC while a retained plan needs it.
CREATE TABLE job_config_refs (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, config_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,job_id,config_id), FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id), FOREIGN KEY(tenant_id,config_id) REFERENCES provider_configs(tenant_id,id)
);
CREATE TABLE idempotency_admissions (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, kind varchar(8) NOT NULL CHECK(kind IN ('search','fetch')), key varchar(128) NOT NULL,
 canonical_content bytea NOT NULL, content_sha256 bytea NOT NULL CHECK(octet_length(content_sha256)=32), job_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,kind,key), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE usage_reservations (
 job_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, group_id uuid NOT NULL, key_id uuid NOT NULL,
 utc_day date NOT NULL, key_epoch integer NOT NULL, units bigint NOT NULL CHECK(units>0), state varchar(16) NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),
 reason varchar(64) NOT NULL DEFAULT 'admitted', created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id), FOREIGN KEY(tenant_id,user_id,group_id,utc_day) REFERENCES group_usage_buckets(tenant_id,user_id,group_id,utc_day), FOREIGN KEY(tenant_id,key_id,key_epoch) REFERENCES key_usage_buckets(tenant_id,key_id,epoch),
 CHECK((state='reserved' AND settled_at IS NULL) OR (state<>'reserved' AND settled_at IS NOT NULL))
);
CREATE TABLE usage_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, group_id uuid NOT NULL, key_id uuid NOT NULL, job_id uuid NOT NULL,
 event varchar(8) NOT NULL CHECK(event IN ('reserve','settle','release')), units bigint NOT NULL CHECK(units>0), utc_day date NOT NULL, key_epoch integer NOT NULL,
 request_id varchar(128) NOT NULL, safe_reason varchar(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,event), FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX usage_owner_idx ON usage_events(tenant_id,user_id,created_at,id);
CREATE TABLE artifacts (
 job_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, media_type varchar(32) NOT NULL DEFAULT 'application/json' CHECK(media_type='application/json'),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216), sha256 varchar(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,job_id), FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE artifact_chunks (
 tenant_id uuid NOT NULL, job_id uuid NOT NULL, index integer NOT NULL CHECK(index>=0), "offset" integer NOT NULL CHECK("offset">=0),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 12288), data bytea NOT NULL,
 PRIMARY KEY(job_id,index), UNIQUE(job_id,"offset"), FOREIGN KEY(tenant_id,job_id) REFERENCES artifacts(tenant_id,job_id), CHECK(octet_length(data)=byte_length)
);
CREATE FUNCTION nbcloud_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_RESOURCE'; END $$;
CREATE TRIGGER provider_config_immutable BEFORE UPDATE ON provider_configs FOR EACH ROW EXECUTE FUNCTION nbcloud_immutable();
CREATE TRIGGER artifact_immutable BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION nbcloud_immutable();
CREATE TRIGGER chunk_immutable BEFORE UPDATE ON artifact_chunks FOR EACH ROW EXECUTE FUNCTION nbcloud_immutable();
CREATE FUNCTION nbcloud_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.user_id,NEW.group_id,NEW.admitting_key_id,NEW.kind,NEW.delivery,NEW.created_at,NEW.selection) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.user_id,OLD.group_id,OLD.admitting_key_id,OLD.kind,OLD.delivery,OLD.created_at,OLD.selection) THEN RAISE EXCEPTION 'IMMUTABLE_JOB_IDENTITY'; END IF;
 IF OLD.state IN ('succeeded','failed','cancelled') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'TERMINAL_JOB'; END IF;
 IF OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'IMMUTABLE_EXPIRY'; END IF;
 IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN RAISE EXCEPTION 'IMMUTABLE_DISPATCH'; END IF;
 IF NEW.first_plan IS DISTINCT FROM OLD.first_plan AND NOT(COALESCE(OLD.expires_at<=now(),false) AND NEW.first_plan IS NULL AND NEW.purged_at IS NOT NULL) THEN RAISE EXCEPTION 'IMMUTABLE_PLAN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jobs_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION nbcloud_job_guard();
CREATE TRIGGER providers_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON providers FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
CREATE TRIGGER lanes_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON lanes FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
CREATE TRIGGER group_lanes_bump_tenant_revision AFTER INSERT OR UPDATE OR DELETE ON group_lanes FOR EACH ROW EXECUTE FUNCTION nbcloud_bump_tenant_revision();
