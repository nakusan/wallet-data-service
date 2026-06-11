-- API 请求审计日志（按月分区，建议保留 6 个月后 DROP 旧分区）
CREATE TABLE IF NOT EXISTS request_audit (
  id           BIGSERIAL,
  api_key_id   BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  ip           INET,
  method       VARCHAR(10),
  path         TEXT,
  query_params JSONB,
  status_code  SMALLINT,
  duration_ms  INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, requested_at)
) PARTITION BY RANGE (requested_at);

CREATE TABLE IF NOT EXISTS request_audit_2026_06
  PARTITION OF request_audit
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS request_audit_2026_07
  PARTITION OF request_audit
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS request_audit_2026_08
  PARTITION OF request_audit
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
