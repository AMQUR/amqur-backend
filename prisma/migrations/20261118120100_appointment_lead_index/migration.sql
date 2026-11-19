-- Additive: index for the "latest appointment of this lead" lookup done on every ADF lead
-- delivery (LeadDeliveryService: WHERE tenantId = ? AND leadId = ? ORDER BY createdAt DESC).
CREATE INDEX "Appointment_tenantId_leadId_createdAt_idx" ON "Appointment"("tenantId", "leadId", "createdAt");
