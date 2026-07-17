-- Disabled-user support: users default to active; disabling blocks login and refresh.
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
