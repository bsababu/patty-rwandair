CREATE TABLE "CrewSubmission" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "duty" TEXT NOT NULL,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CrewSubmission_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Notification" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "Notification" ADD COLUMN "flightId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "actionPath" TEXT;

CREATE UNIQUE INDEX "CrewSubmission_flightId_userId_key" ON "CrewSubmission"("flightId", "userId");
CREATE INDEX "CrewSubmission_flightId_submittedAt_idx" ON "CrewSubmission"("flightId", "submittedAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

ALTER TABLE "CrewSubmission" ADD CONSTRAINT "CrewSubmission_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrewSubmission" ADD CONSTRAINT "CrewSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
