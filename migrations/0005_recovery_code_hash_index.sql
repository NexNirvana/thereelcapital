-- Redemption looks a code up by its hash alone (src/lib/server/recovery-codes.ts), which the
-- (user_id, code_hash) key cannot serve. Unique also keeps that lookup unambiguous.
CREATE UNIQUE INDEX recovery_codes_code_hash_idx ON recovery_codes (code_hash);
