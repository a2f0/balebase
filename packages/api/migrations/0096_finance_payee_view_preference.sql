-- A person's choice to open Finance's transactions grouped by payee rather
-- than as a list. Off for everyone at first.
ALTER TABLE "user" ADD COLUMN "financeOpensByPayee" INTEGER NOT NULL
  DEFAULT 0 CHECK ("financeOpensByPayee" IN (0, 1));
