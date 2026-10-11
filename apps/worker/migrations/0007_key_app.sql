-- Which app a key was made for (Claude Code, Cursor, a script…), now that one key per app is the way
-- to connect: its agents name themselves. Added, not changed, so the previous Worker still runs.
ALTER TABLE keys ADD COLUMN app TEXT;
