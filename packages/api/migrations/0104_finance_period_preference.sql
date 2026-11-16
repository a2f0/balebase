-- A person's choice of the period Finance's transactions open on: every
-- transaction, or those dated in the current or previous calendar year.
-- Every transaction for everyone at first, as before.
ALTER TABLE "user" ADD COLUMN "financeOpensPeriod" TEXT NOT NULL
  DEFAULT 'allTime'
  CHECK ("financeOpensPeriod" IN ('allTime', 'currentYear', 'previousYear'));
