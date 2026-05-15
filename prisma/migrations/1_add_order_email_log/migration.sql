-- CreateTable
CREATE TABLE "OrderEmailLog" (
    "id" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "productsSummary" TEXT NOT NULL,
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'UNFULFILLED',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "confirmationReadyAt" TIMESTAMP(3),
    "shippingReadyAt" TIMESTAMP(3),
    "confirmationEmailSentAt" TIMESTAMP(3),
    "shippingEmailSentAt" TIMESTAMP(3),
    "emailStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastEmailError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderEmailLog_shopifyOrderId_key" ON "OrderEmailLog"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderEmailLog_emailStatus_idx" ON "OrderEmailLog"("emailStatus");

-- CreateIndex
CREATE INDEX "OrderEmailLog_carrier_idx" ON "OrderEmailLog"("carrier");
