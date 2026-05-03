npm warn Unknown project config "shamefully-hoist". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "UgcCreator" (
    "id" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "instagram" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "videoLink" TEXT,
    "shippingCost" DOUBLE PRECISION NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UgcCreator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "instagram" TEXT NOT NULL,
    "tiktok" TEXT NOT NULL,
    "contact" TEXT,
    "type" TEXT,
    "plateforme" TEXT,
    "pays" TEXT NOT NULL,
    "produit" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'preparation',
    "shippingStatus" TEXT NOT NULL DEFAULT 'en_attente',
    "contentStatus" TEXT NOT NULL DEFAULT 'a_faire',
    "fraisPort" DOUBLE PRECISION NOT NULL,
    "trackingNumber" TEXT,
    "codePromo" TEXT,
    "dateLivraison" TEXT,
    "quantite" INTEGER NOT NULL DEFAULT 1,
    "coutProduit" DOUBLE PRECISION,
    "coutTotalCollab" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achat" (
    "id" TEXT NOT NULL,
    "dateCommande" TEXT NOT NULL,
    "numeroCommande" TEXT NOT NULL,
    "fournisseur" TEXT NOT NULL,
    "produit" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "prixUnitaireHT" DOUBLE PRECISION NOT NULL,
    "fraisLivraison" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fraisDouane" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "autresFrais" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coutTotalHT" DOUBLE PRECISION NOT NULL,
    "tva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coutTotalTTC" DOUBLE PRECISION NOT NULL,
    "dateReception" TEXT,
    "statut" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Achat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vente" (
    "id" TEXT NOT NULL,
    "dateVente" TEXT NOT NULL,
    "numeroCommande" TEXT NOT NULL,
    "canalVente" TEXT NOT NULL,
    "pays" TEXT NOT NULL,
    "produitVendu" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "prixVente" DOUBLE PRECISION NOT NULL,
    "remise" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prixNet" DOUBLE PRECISION NOT NULL,
    "tva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prixEncaisse" DOUBLE PRECISION NOT NULL,
    "fraisLivraisonClient" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coutLivraisonReel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "coutProduit" DOUBLE PRECISION NOT NULL,
    "coutPub" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "margeBrute" DOUBLE PRECISION NOT NULL,
    "margeNette" DOUBLE PRECISION NOT NULL,
    "statut" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Depense" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "fournisseur" TEXT NOT NULL,
    "montantHT" DOUBLE PRECISION NOT NULL,
    "tva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "montantTTC" DOUBLE PRECISION NOT NULL,
    "moyenPaiement" TEXT NOT NULL,
    "moisComptable" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Depense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProduitOffert" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "beneficiaire" TEXT,
    "produit" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "coutUnitaire" DOUBLE PRECISION NOT NULL,
    "coutTotal" DOUBLE PRECISION NOT NULL,
    "potsEquivalent" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProduitOffert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Todo" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Todo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vente_numeroCommande_key" ON "Vente"("numeroCommande");

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

