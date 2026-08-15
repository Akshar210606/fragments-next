-- CreateTable
CREATE TABLE "fragments" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fragments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fragments_ownerId_id_idx" ON "fragments"("ownerId", "id");
