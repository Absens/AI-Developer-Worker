ALTER TABLE telegram_profile_automation_connections
  ADD COLUMN IF NOT EXISTS can_read_messages boolean;
