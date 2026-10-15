import { meetingStoreTables } from '../../stores/sql.js';

/**
 * An earlier form of the meeting stores' schema, frozen here for the upgrade test: the six tables and their indexes
 * without any column `meetingStoresUpgradeDdl` adds, so the test can make them, write a row the way an earlier version
 * did, and bring them to the current schema.
 *
 * @param tablePrefix - The prefix the tables are made under, checked as the stores check it.
 */
export function legacyMeetingStoresDdl(tablePrefix: string): string {
  const t = meetingStoreTables(tablePrefix);
  const p = tablePrefix;
  return `
CREATE TABLE IF NOT EXISTS ${t.runs} (
  run_id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  keep TEXT NOT NULL,
  meeting_url TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  notice_text TEXT NOT NULL,
  notice_version TEXT NOT NULL,
  notice_late_text TEXT NOT NULL,
  stop_phrase TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  idempotency_key TEXT,
  transcriber TEXT,
  requested_at BIGINT NOT NULL,
  join_at BIGINT NOT NULL,
  dispatched_at BIGINT,
  joined_at BIGINT,
  notice_posted_at BIGINT,
  capture_started_at BIGINT,
  left_at BIGINT,
  done_at BIGINT,
  reason TEXT,
  billed_seconds INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,
  consent_record_id TEXT,
  dispatch_json TEXT,
  page_seen_at BIGINT,
  last_usage_at BIGINT,
  monitor_seen_at BIGINT,
  participant_count INTEGER,
  reported_seconds INTEGER,
  cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
  purged_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${p}_runs_idem ON ${t.runs} (owner_ref, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${p}_runs_owner ON ${t.runs} (owner_ref, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_${p}_runs_state ON ${t.runs} (state);
CREATE TABLE IF NOT EXISTS ${t.jobs} (
  run_id TEXT PRIMARY KEY,
  dispatch_at BIGINT NOT NULL,
  lease_holder TEXT,
  lease_expires_at BIGINT,
  worker_id TEXT,
  dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_${p}_jobs_due ON ${t.jobs} (dispatch_at) WHERE NOT dispatched AND NOT cancelled;
CREATE TABLE IF NOT EXISTS ${t.locks} (
  run_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL DEFAULT 0,
  fenced_at BIGINT
);
CREATE TABLE IF NOT EXISTS ${t.turns} (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS ${t.events} (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at BIGINT NOT NULL,
  data_json TEXT,
  purged BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${p}_events_id ON ${t.events} (event_id);
CREATE TABLE IF NOT EXISTS ${t.outbox} (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at BIGINT,
  next_at BIGINT NOT NULL,
  state TEXT NOT NULL,
  purged BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_${p}_outbox_due ON ${t.outbox} (next_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_${p}_outbox_run ON ${t.outbox} (run_id);
`;
}
