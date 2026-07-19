/**
 * Temporary local smoke trigger for MAMS task/start.
 * Usage: node scripts/tmp-start-task.mjs
 */

const payload = {
  objective: 'להחליף בעמוד הראשי את המונח "המשחקים הקבועים שלי" ל"הקבוצות שלי"',
  executionTier: 'TIER2_STANDARD',
  acceptanceCriteria: [
    'להחליף בעמוד הראשי את המונח "המשחקים הקבועים שלי" ל"הקבוצות שלי"',
  ],
  contact: 'yairkla',
};

const response = await fetch('http://localhost:8080/api/mams/task/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});

const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);

if (!response.ok) {
  process.exit(1);
}

try {
  const data = JSON.parse(text);
  if (data.taskId) {
    console.log(`\nTASK_ID=${data.taskId}`);
  }
} catch {
  // response already printed
}
