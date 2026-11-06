-- A person's choice to open Finance on their uncategorized expenses (from the
-- sidebar) rather than on every transaction. Off for everyone at first.
ALTER TABLE "user" ADD COLUMN "financeOpensUncategorized" INTEGER NOT NULL
  DEFAULT 0 CHECK ("financeOpensUncategorized" IN (0, 1));
