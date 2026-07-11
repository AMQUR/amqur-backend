-- Production hardening: tenant-scoped uniqueness + core CRM/chat tables

-- Location: drop global slug unique, add per-tenant unique
DROP INDEX IF EXISTS "Location_slug_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Location_tenantId_slug_key" ON "Location"("tenantId", "slug");
CREATE INDEX IF NOT EXISTS "Location_tenantId_idx" ON "Location"("tenantId");

ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "storeHours" JSONB;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- User: drop global email unique, add per-tenant unique
DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User"("email");
CREATE INDEX IF NOT EXISTS "User_tenantId_idx" ON "User"("tenantId");

-- Vehicle: drop global VIN unique, add per-tenant unique + indexes
DROP INDEX IF EXISTS "Vehicle_vin_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_tenantId_vin_key" ON "Vehicle"("tenantId", "vin");
CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_status_idx" ON "Vehicle"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_make_model_idx" ON "Vehicle"("tenantId", "make", "model");
CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_price_idx" ON "Vehicle"("tenantId", "price");
CREATE INDEX IF NOT EXISTS "Vehicle_locationId_idx" ON "Vehicle"("locationId");
CREATE INDEX IF NOT EXISTS "Vehicle_stock_idx" ON "Vehicle"("stock");

ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "interiorColor" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "features" JSONB;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "source" TEXT;

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "allowedOrigins" TEXT;

-- Enums
DO $$ BEGIN CREATE TYPE "ConversationChannel" AS ENUM ('WIDGET', 'STAFF', 'SMS', 'EMAIL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LeadStage" AS ENUM ('COLD', 'WARM', 'HOT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LeadStatus" AS ENUM ('OPEN', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'CLOSED', 'SPAM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AppointmentType" AS ENUM ('SALES', 'SERVICE', 'PARTS', 'FINANCE', 'TEST_DRIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EscalationUrgency" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "externalKey" TEXT NOT NULL,
    "channel" "ConversationChannel" NOT NULL DEFAULT 'WIDGET',
    "state" JSONB NOT NULL DEFAULT '{}',
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_tenantId_externalKey_key" ON "Conversation"("tenantId", "externalKey");
CREATE INDEX IF NOT EXISTS "Conversation_tenantId_lastActivityAt_idx" ON "Conversation"("tenantId", "lastActivityAt");

CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

CREATE TABLE IF NOT EXISTS "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "zipCode" TEXT,
    "interestedVin" TEXT,
    "interestedStock" TEXT,
    "budget" INTEGER,
    "desiredPayment" INTEGER,
    "financingNeeded" BOOLEAN,
    "preferredContact" TEXT,
    "consentToText" BOOLEAN NOT NULL DEFAULT false,
    "consentToEmail" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'widget',
    "score" INTEGER NOT NULL DEFAULT 0,
    "stage" "LeadStage" NOT NULL DEFAULT 'COLD',
    "status" "LeadStatus" NOT NULL DEFAULT 'OPEN',
    "assignedUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Lead_tenantId_email_idx" ON "Lead"("tenantId", "email");
CREATE INDEX IF NOT EXISTS "Lead_tenantId_phone_idx" ON "Lead"("tenantId", "phone");
CREATE INDEX IF NOT EXISTS "Lead_conversationId_idx" ON "Lead"("conversationId");

CREATE TABLE IF NOT EXISTS "Appointment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "type" "AppointmentType" NOT NULL DEFAULT 'SALES',
    "requestedDate" TEXT,
    "requestedTime" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "vehicleVin" TEXT,
    "notes" TEXT,
    "availabilityVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Appointment_tenantId_status_idx" ON "Appointment"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Appointment_tenantId_scheduledAt_idx" ON "Appointment"("tenantId", "scheduledAt");
CREATE INDEX IF NOT EXISTS "Appointment_conversationId_idx" ON "Appointment"("conversationId");

CREATE TABLE IF NOT EXISTS "Escalation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "reason" TEXT NOT NULL,
    "urgency" "EscalationUrgency" NOT NULL DEFAULT 'NORMAL',
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT,
    "metadata" JSONB,
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Escalation_tenantId_status_idx" ON "Escalation"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Escalation_conversationId_idx" ON "Escalation"("conversationId");

CREATE TABLE IF NOT EXISTS "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");

-- FKs (ignore if already present)
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
