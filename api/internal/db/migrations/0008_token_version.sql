-- Session revocation support: a per-user token version embedded as a JWT claim.
-- Bumping this column invalidates every previously issued session token for the
-- user (logout, password change), since Parse rejects tokens whose claim differs
-- from the current DB value.

ALTER TABLE users
    ADD COLUMN token_version int NOT NULL DEFAULT 0;
