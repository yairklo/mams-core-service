/**
 * Start MAMS task: game join notifications + message/chat actions.
 * Usage: node scripts/tmp-start-join-notifications.mjs
 */

const payload = {
  objective:
    "הוספת התראות על הצטרפות למשחק: כששחקן מצטרף למשחק שלי, אני רוצה לקבל התראה. במסך/במקום ההתראה אני רוצה יכולת לשלוח לו הודעה ישירה. בנוסף, להוסיף אפשרות (לא חובה) לפתוח צ'אט ישיר עם כל שחקן שהצטרף למשחק, כולל אפשרות להודעה אוטומטית ברגע הצטרפות.",
  executionTier: "TIER3_CRITICAL",
  acceptanceCriteria: [
    "When a player joins a game, the game owner receives a notification (push and/or in-app) that clearly states who joined and which game.",
    "From the join notification UI, the owner can send a direct message to the joining player without leaving the notification context.",
    "Provide an optional action to open a direct 1:1 chat with each player who joined the game (e.g. from notification or participants list).",
    "Optional: support configuring/sending an automatic welcome message when someone joins (can be off by default).",
    "Reuse existing notification, messaging/chat, and socket infrastructure where possible; do not break existing game join flows.",
    "Add or update relevant server endpoints/events and mobile UI with i18n (he/en) for new strings.",
  ],
  pmContext: {
    initialRequest: {
      feature: "game_join_notifications",
      requestedBy: "yairkla",
      productNotes:
        "Owner should be notified on join; notification should enable messaging; optional direct chat per joined player.",
    },
  },
};

const response = await fetch("http://localhost:8080/api/mams/task/start", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
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
