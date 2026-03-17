-- Migration: Tier 2 audit fixes (March 17, 2026)
-- Add calendar_token to profiles for calendar feed security

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS calendar_token text;

-- Generate a random token for all existing profiles that don't have one
UPDATE profiles
SET calendar_token = encode(gen_random_bytes(16), 'hex')
WHERE calendar_token IS NULL;
