-- Key membership is immutable with the provider configuration; queued jobs retain it.
CREATE TABLE provider_config_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  config_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  label varchar(100) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  secret_key_id varchar(128) NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)>0),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  UNIQUE(config_id,ordinal),
  UNIQUE(secret_key_id,nonce),
  FOREIGN KEY(tenant_id,config_id) REFERENCES provider_configs(tenant_id,id) ON DELETE CASCADE
);
CREATE TRIGGER provider_config_key_immutable BEFORE UPDATE ON provider_config_keys FOR EACH ROW EXECUTE FUNCTION nbcloud_immutable();
CREATE TABLE provider_key_counters (
  tenant_id uuid NOT NULL,
  config_id uuid PRIMARY KEY,
  selections bigint NOT NULL DEFAULT 0 CHECK (selections >= 0),
  FOREIGN KEY(tenant_id,config_id) REFERENCES provider_configs(tenant_id,id) ON DELETE CASCADE
);
