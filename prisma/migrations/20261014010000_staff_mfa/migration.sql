-- Staff TOTP MFA (additive)
ALTER TABLE "User" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "mfaSecretEnc" JSONB,
ADD COLUMN "mfaPendingSecretEnc" JSONB,
ADD COLUMN "mfaRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "mfaLastCounter" INTEGER,
ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);
