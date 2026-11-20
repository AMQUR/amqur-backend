-- Additive: record which mode ('sandbox' | 'live') a lead delivery was handed off in, so a
-- sandbox acknowledgement can never be mistaken for an acknowledgement on a live route.
ALTER TABLE "LeadDelivery" ADD COLUMN "deliveryMode" TEXT;

-- No live send has ever been made (live mode has never been enabled anywhere): every hand-off
-- recorded before this column existed was a sandbox hand-off.
UPDATE "LeadDelivery" SET "deliveryMode" = 'sandbox' WHERE "sentAt" IS NOT NULL;

ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_deliveryMode_chk"
  CHECK ("deliveryMode" IS NULL OR "deliveryMode" IN ('sandbox', 'live'));
