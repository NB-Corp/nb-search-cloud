ALTER TABLE providers DROP CONSTRAINT providers_provider_id_check;
ALTER TABLE providers ADD CONSTRAINT providers_provider_id_check CHECK(provider_id IN ('exa','grok-multi-agent','script'));
