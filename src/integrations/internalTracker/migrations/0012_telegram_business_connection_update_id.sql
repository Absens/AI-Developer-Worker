ALTER TABLE telegram_profile_automation_connections
  ADD COLUMN IF NOT EXISTS update_id bigint;
