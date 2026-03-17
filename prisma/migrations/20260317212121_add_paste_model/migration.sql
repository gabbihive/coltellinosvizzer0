-- CreateTable
CREATE TABLE "Paste" (
    "id" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "burnAfterRead" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Paste_pkey" PRIMARY KEY ("id")
);
