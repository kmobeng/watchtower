-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET');

-- CreateTable
CREATE TABLE "monitors" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" "HttpMethod" NOT NULL DEFAULT 'GET',
    "interval_seconds" INTEGER NOT NULL,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "failure_threshold" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitors_user_id_idx" ON "monitors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "monitors_user_id_url_key" ON "monitors"("user_id", "url");

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
