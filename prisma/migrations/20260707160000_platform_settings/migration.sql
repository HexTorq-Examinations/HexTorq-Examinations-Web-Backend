CREATE TABLE "PlatformSetting" (
  "id" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "organizationId" TEXT,
  "data" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformSetting_scopeKey_key" ON "PlatformSetting"("scopeKey");
CREATE UNIQUE INDEX "PlatformSetting_organizationId_key" ON "PlatformSetting"("organizationId");
ALTER TABLE "PlatformSetting" ADD CONSTRAINT "PlatformSetting_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
