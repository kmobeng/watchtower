-- Enforce at most one non-resolved incident per monitor.
-- Application code opens idempotently (find-first), but concurrent workers
-- could still race an open; this constraint makes double-open impossible and
-- surfaces as P2002, which the service converts into "return the existing".
CREATE UNIQUE INDEX "incidents_one_open_per_monitor"
  ON "incidents"("monitor_id")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED');
