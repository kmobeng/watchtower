-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "escalation_policy_id" TEXT;

-- AlterTable
ALTER TABLE "incidents" ADD COLUMN     "acknowledged_at" TIMESTAMP(3),
ADD COLUMN     "escalation_step" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_escalation_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "escalation_policies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "escalation_policies_user_id_idx" ON "escalation_policies"("user_id");

-- CreateIndex
CREATE INDEX "monitors_escalation_policy_id_idx" ON "monitors"("escalation_policy_id");

-- CreateIndex
CREATE INDEX "incidents_status_next_escalation_at_idx" ON "incidents"("status", "next_escalation_at");

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_escalation_policy_id_fkey" FOREIGN KEY ("escalation_policy_id") REFERENCES "escalation_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
