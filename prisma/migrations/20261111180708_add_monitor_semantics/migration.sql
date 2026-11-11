-- CreateEnum
CREATE TYPE "MonitorState" AS ENUM ('UNKNOWN', 'UP', 'SUSPICIOUS', 'DOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HttpMethod" ADD VALUE 'HEAD';
ALTER TYPE "HttpMethod" ADD VALUE 'POST';

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "response_time_threshold_ms" INTEGER,
ADD COLUMN     "state" "MonitorState" NOT NULL DEFAULT 'UNKNOWN';
