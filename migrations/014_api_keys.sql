-- API Key 管理（多租户，不同钱包 App 接入）
-- key_hash = SHA-256(raw_key)，明文不落库
CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL PRIMARY KEY,
  key_hash     VARCHAR(64) NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  rate_limit   INTEGER NOT NULL DEFAULT 1000,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys (is_active);
