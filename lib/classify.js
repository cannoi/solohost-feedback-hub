export const TYPES = ["bug", "idea", "improvement", "review", "payment", "thanks"];
export const STATUSES = ["NEW", "REVIEWING", "PLANNED", "IN_PROGRESS", "DONE", "DECLINED"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];

const BUG_RE = /\b(bug|crash|error|fail|lỗi|sập|treo|không chạy|broken|exception)\b/i;
const IDEA_RE = /\b(idea|ý tưởng|feature|tính năng|nên có|wish|muốn có)\b/i;
const PAY_RE = /\b(paid|thanh toán|ủng hộ|donate|pi payment|đã chuyển)\b/i;
const POS_RE = /\b(good|great|hay|tuyệt|love|cảm ơn|thank|ổn|đẹp)\b/i;
const NEG_RE = /\b(bad|tệ|chán|slow|chậm|hate|không thích|kém)\b/i;

export function localClassify(item) {
  const text = `${item.type || ""} ${item.message || ""}`.toLowerCase();
  let type = TYPES.includes(item.type) ? item.type : "improvement";
  if (PAY_RE.test(text)) type = "payment";
  else if (BUG_RE.test(text)) type = "bug";
  else if (IDEA_RE.test(text)) type = "idea";

  let sentiment = "neutral";
  if (POS_RE.test(text) && !NEG_RE.test(text)) sentiment = "positive";
  if (NEG_RE.test(text)) sentiment = "negative";
  if (item.rating >= 4) sentiment = "positive";
  if (item.rating && item.rating <= 2) sentiment = "negative";

  let priority = "P2";
  if (type === "bug" && sentiment === "negative") priority = "P0";
  else if (type === "bug") priority = "P1";
  else if (type === "idea") priority = "P2";
  else if (type === "review" && sentiment === "positive") priority = "P3";

  return {
    type,
    sentiment,
    priority,
    tags: [type, sentiment, priority],
    summary: (item.message || "").slice(0, 140),
    suggested_action: suggest(type, sentiment, item),
    classifier: "local",
  };
}

function suggest(type, sentiment, item) {
  if (type === "bug") return `Reproduce on ${item.app_id || "app"} ${item.version || ""} then ship smallest safe fix.`;
  if (type === "idea") return "Cluster with similar ideas; only build if 3+ users ask or it unblocks a paid workflow.";
  if (type === "payment") return "Mark supporter, send thank-you notice, unlock supporter features.";
  if (type === "review" && sentiment === "negative") return "Reply personally and convert into a concrete upgrade task.";
  if (type === "review") return "Quote in update notes; no code change required.";
  return "Triage in admin board; attach to an upgrade task only after you accept it.";
}

export function scoreApp(app, items, payments) {
  const mine = items.filter((x) => x.app_id === app.app_id);
  const pays = payments.filter((x) => x.app_id === app.app_id && x.status === "confirmed");
  const bugs = mine.filter((x) => x.type === "bug" && x.status !== "DONE" && x.status !== "DECLINED");
  const ideas = mine.filter((x) => x.type === "idea" || x.type === "improvement");
  const ratings = mine.map((x) => Number(x.rating)).filter((n) => n > 0);
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const heat = mine.filter((x) => Date.now() - new Date(x.created_at).getTime() < 14 * 864e5).length;
  const unpaid = app.fee_required && !pays.length;
  return {
    ...app,
    feedback_count: mine.length,
    open_bugs: bugs.length,
    ideas: ideas.length,
    avg_rating: Math.round(avg * 10) / 10,
    heat,
    supporters: pays.length,
    unpaid,
    rank_score: heat * 3 + bugs.length * 4 + ideas.length + (5 - (avg || 3)),
  };
}
