-- Additive: provider receipts for appointments (one row per scheduling-provider response).
-- CreateTable
CREATE TABLE "AppointmentProviderReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "status" TEXT NOT NULL,
    "confirmedStart" TIMESTAMP(3),
    "rawStatus" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AppointmentProviderReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentProviderReceipt_tenantId_provider_providerRef_key" ON "AppointmentProviderReceipt"("tenantId", "provider", "providerRef");

-- CreateIndex
CREATE INDEX "AppointmentProviderReceipt_appointmentId_idx" ON "AppointmentProviderReceipt"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentProviderReceipt_tenantId_receivedAt_idx" ON "AppointmentProviderReceipt"("tenantId", "receivedAt");

-- AddForeignKey
ALTER TABLE "AppointmentProviderReceipt" ADD CONSTRAINT "AppointmentProviderReceipt_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
