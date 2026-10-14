-- Authenticated API requests stamp this. Existing users start from account
-- creation, the last activity known before tracking began.
ALTER TABLE "user" ADD COLUMN "lastActiveAt" DATE;

UPDATE "user" SET "lastActiveAt" = "createdAt";
