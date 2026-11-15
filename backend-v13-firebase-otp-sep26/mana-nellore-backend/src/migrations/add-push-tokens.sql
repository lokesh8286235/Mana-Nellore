-- Migration: push_tokens table for FCM device tokens (idempotent — safe to re-run).
-- Registered by apps via POST /api/push/token; read by src/lib/fcm.js when sending.
-- Also present in src/schema.sql (auto-run on boot); this file is the record.
CREATE TABLE IF NOT EXISTS push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('android','ios','web')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
