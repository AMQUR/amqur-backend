-- Additive: one nullable column on a CRM Workforce table. No data changes.
ALTER TABLE "CrmWfConnector" ADD COLUMN "syncCursor" TEXT;
