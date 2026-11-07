-- DropIndex
DROP INDEX "checks_monitor_id_checked_at_idx";

-- CreateIndex
CREATE INDEX "checks_monitor_id_region_checked_at_idx" ON "checks"("monitor_id", "region", "checked_at" DESC);
