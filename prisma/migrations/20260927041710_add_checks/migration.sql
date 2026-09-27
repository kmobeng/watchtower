-- CreateTable
CREATE TABLE "checks" (
    "id" TEXT NOT NULL,
    "monitor_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "region" TEXT NOT NULL DEFAULT 'local',
    "status_code" INTEGER,
    "response_time_ms" INTEGER NOT NULL,
    "is_up" BOOLEAN NOT NULL,
    "timed_out" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checks_monitor_id_checked_at_idx" ON "checks"("monitor_id", "checked_at" DESC);

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
