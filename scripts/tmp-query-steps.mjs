import { PrismaClient } from "@prisma/client";

const taskId = "da0f1d51-52f5-4561-aa69-996c7b234b2b";
const prisma = new PrismaClient();
const rows = await prisma.agentStepRecord.findMany({
  where: { taskId },
  orderBy: { stepIndex: "asc" },
  select: { stepId: true, stepIndex: true, role: true, createdAt: true },
});
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
