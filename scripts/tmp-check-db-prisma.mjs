import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const schemas = await prisma.$queryRawUnsafe("SELECT schema_name FROM information_schema.schemata;");
  console.log("Schemas from Prisma Client:", schemas);
  await prisma.$disconnect();
}

main().catch(console.error);
