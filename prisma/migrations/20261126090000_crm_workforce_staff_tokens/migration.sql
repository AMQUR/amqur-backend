-- CreateTable
CREATE TABLE "CrmWfStaffToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfStaffToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfStaffToken_tokenHash_key" ON "CrmWfStaffToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CrmWfStaffToken_tenantId_userId_idx" ON "CrmWfStaffToken"("tenantId", "userId");

