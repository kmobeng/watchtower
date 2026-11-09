-- CreateEnum
CREATE TYPE "RollupGranularity" AS ENUM ('HOUR', 'DAY');

-- CreateTable
CREATE TABLE "check_rollups" (
    "id" TEXT NOT NULL,
    "monitor_id" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'local',
    "granularity" "RollupGranularity" NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "check_count" INTEGER NOT NULL,
    "up_count" INTEGER NOT NULL,
    "up_response_time_sum_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_rollups_granularity_bucket_start_idx" ON "check_rollups"("granularity", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "check_rollups_monitor_id_region_granularity_bucket_start_key" ON "check_rollups"("monitor_id", "region", "granularity", "bucket_start");

-- CreateIndex
CREATE INDEX "checks_checked_at_idx" ON "checks"("checked_at");

-- AddForeignKey
ALTER TABLE "check_rollups" ADD CONSTRAINT "check_rollups_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
