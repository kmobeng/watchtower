-- CreateTable
CREATE TABLE "status_pages" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "monitor_ids" TEXT[],
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "status_pages_slug_key" ON "status_pages"("slug");

-- CreateIndex
CREATE INDEX "status_pages_user_id_idx" ON "status_pages"("user_id");

-- AddForeignKey
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
