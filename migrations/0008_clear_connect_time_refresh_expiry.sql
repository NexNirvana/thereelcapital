-- D44: refresh_expires_at is now set only when a rotation is first observed. Before, connecting set it
-- to connect time + 24 h, and a rotation kept that value, so a stored value cannot tell a rotated row
-- from one that never rotated. The SIM spikes of 2026-10-22 and 2026-10-26 showed this key does not
-- rotate, so every stored value is a connect-time guess: clear them. A row that does rotate gets
-- now + 24 h at its next rotation, and a refused refresh still marks any row revoked.
-- EXPIRED is final in the refresher, so rows the old countdown already expired return to CONNECTED; a
-- row whose key really is dead is refused on its next refresh and becomes REVOKED. REVOKED stays.
UPDATE broker_connection
   SET refresh_expires_at = NULL,
       status = CASE WHEN status = 'EXPIRED' THEN 'CONNECTED' ELSE status END;
