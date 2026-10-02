// Feedback insights: groups ALL comments / ratings / feedback into themes and ranks them by how many people asked.
// Deterministic (no AI needed). AI may only re-word titles/actions afterwards; it can never change the order or the counts.
import { localClassify } from "./classify.js";

const CLOSED = new Set(["DONE", "DECLINED"]);
const SKIP_TYPES = new Set(["payment", "thanks"]);

// accent-insensitive matching: "không chạy" == "khong chay"
export function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// severity 2 = app unusable / data loss, 1 = hurts daily use, 0 = nice to have
const THEMES = [
  { id: "crash", sev: 2, title: "App bị sập / treo / văng", re: /\b(crash|sap|treo|dung hinh|dong bang|force close|van ra|thoat ra|bi thoat|exception|freeze|frozen)\b/ },
  { id: "not_running", sev: 2, title: "App không mở / không chạy / màn hình trắng", re: /(khong (chay|mo|vao|hien|load|len)|man hinh trang|trang trang|white screen|blank|cannot get|404|500|not working|doesn t work|does not work|khong dung duoc)/ },
  { id: "data_loss", sev: 2, title: "Mất dữ liệu / không lưu được", re: /(mat du lieu|mat het|khong luu|ko luu|luu khong duoc|data loss|lost data|not saved|khong sao luu|xoa mat)/ },
  { id: "login", sev: 2, title: "Đăng nhập / tài khoản / mật khẩu", re: /(dang nhap|dang ky|login|log in|sign in|mat khau|password|tai khoan|account|otp)/ },
  { id: "payment", sev: 1, title: "Thanh toán / ủng hộ / ví Pi", re: /(thanh toan|giao dich|vi pi|pi payment|payment|donate|ung ho|wallet|chuyen khoan)/ },
  { id: "network", sev: 1, title: "Lỗi mạng / kết nối / offline", re: /(mat mang|loi mang|ket noi|internet|offline|network|timeout|time out|khong co mang|proxy|dns)/ },
  { id: "slow", sev: 1, title: "Chậm / giật lag / tốn pin", re: /\b(cham|lag|giat|slow|load lau|nang may|nong may|hao pin|tot pin|laggy|delay|cho lau)\b/ },
  { id: "ai", sev: 1, title: "AI trả lời sai / không dùng được token AI", re: /(\bai\b|chatbot|tra loi sai|api key|token ai|model|gemini|deepseek|openai|chat bot)/ },
  { id: "ui", sev: 1, title: "Giao diện / hiển thị / khó dùng trên điện thoại", re: /(giao dien|hien thi|bi che|bi tran|bi cat|font|chu nho|man hinh nho|mobile|dien thoai|layout|\bui\b|\bux\b|nut bam|nut khong|kho dung|kho nhin|kho thao tac)/ },
  { id: "language", sev: 0, title: "Ngôn ngữ / dịch thuật", re: /(ngon ngu|tieng viet|tieng anh|language|translate|dich sang|bilingual)/ },
  { id: "theme", sev: 0, title: "Chế độ tối / màu sắc / giao diện tùy chỉnh", re: /(dark mode|che do toi|giao dien toi|theme|mau sac|doi mau)/ },
  { id: "notify", sev: 0, title: "Thông báo / nhắc nhở", re: /(thong bao|notification|nhac nho|nhac lich|reminder)/ },
  { id: "sound", sev: 0, title: "Âm thanh / nhạc / rung", re: /(am thanh|nhac nen|\bsound\b|music|tieng dong|rung)/ },
  { id: "export", sev: 0, title: "Xuất / nhập / chia sẻ dữ liệu", re: /(xuat file|xuat du lieu|nhap file|chia se|share|export|import|tai ve|download|in an|pdf|excel)/ },
  { id: "search", sev: 0, title: "Tìm kiếm / lọc / sắp xếp", re: /(tim kiem|search|bo loc|\bloc\b|filter|sap xep|sort)/ },
  { id: "sync", sev: 0, title: "Đồng bộ nhiều thiết bị", re: /(dong bo|sync|nhieu thiet bi|multi device|cloud)/ },
  { id: "guide", sev: 0, title: "Hướng dẫn sử dụng / dễ dùng hơn", re: /(huong dan|tutorial|onboarding|phuc tap|de dung hon|don gian hon|giai thich)/ },
];

const STOP = new Set(("va la cua cho co khong ko k duoc bi cac nhung mot nay do the thi ma de den tu voi o trong khi rat qua lam sao nua da dang se nen can muon minh toi ban app ung dung the and the for with this that have has are was were not but you your its from just very too can could would should please pls ok oke").split(" "));

function tokens(n) {
  return n.split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function kindOf(row, ai) {
  const t = TYPES_FIX(row, ai);
  return t;
}
function TYPES_FIX(row, ai) {
  if (row.type === "bug" || ai.type === "bug") return "fix";
  if (row.type === "idea" || row.type === "improvement" || ai.type === "idea") return "upgrade";
  if (row.type === "review" || ai.type === "review") {
    const r = Number(row.rating) || 0;
    if ((r && r <= 2) || ai.sentiment === "negative") return "fix";
    if (r >= 4 || ai.sentiment === "positive") return "praise";
    return "upgrade";
  }
  return "upgrade";
}

function priorityOf(c, totals) {
  if (c.kind === "fix") {
    if (c.severity === 2 && c.count >= 2) return "P0";
    if (c.count >= Math.max(3, Math.ceil(totals.fixRows * 0.3))) return "P0";
    return c.count >= 2 || c.severity >= 1 ? "P1" : "P2";
  }
  if (c.count >= Math.max(3, Math.ceil(totals.upgradeRows * 0.3))) return "P1";
  return c.count >= 2 ? "P2" : "P3";
}

function actionOf(c) {
  const where = c.apps.length === 1 ? c.apps[0] : `${c.apps.length} app`;
  if (c.kind === "fix") return `Tái hiện trên ${where}${c.versions[0] ? " " + c.versions[0] : ""}, tìm nguyên nhân gốc rồi sửa thay đổi nhỏ nhất an toàn.`;
  if (c.count >= 3) return `Có ${c.count} lượt yêu cầu từ ${c.users} người dùng — đưa vào kế hoạch nâng cấp kế tiếp.`;
  return "Theo dõi thêm; chỉ làm khi có thêm người yêu cầu hoặc mở khóa tính năng trả phí.";
}

export function buildInsights(rows, opts = {}) {
  const now = opts.now || Date.now();
  const appId = opts.app_id ? String(opts.app_id) : "";
  const includeClosed = Boolean(opts.includeClosed);
  const used = [];
  let skipped = 0;
  for (const r of rows || []) {
    if (!r || (appId && r.app_id !== appId)) continue;
    if (SKIP_TYPES.has(r.type) || r.event === "payment") continue;
    if (!includeClosed && CLOSED.has(r.status)) { skipped++; continue; }
    const msg = String(r.message || "").trim();
    if (msg.length < 3) continue;
    used.push(r);
  }

  const praiseRows = [];
  const clusters = [];
  const byKey = new Map();
  const pending = []; // rows without a known theme -> similarity grouping
  for (const r of used) {
    const ai = localClassify(r);
    const kind = kindOf(r, ai);
    if (kind === "praise") { praiseRows.push(r); continue; }
    const n = norm(r.message);
    const theme = THEMES.find((t) => t.re.test(n));
    const entry = { r, kind, n, tok: new Set(tokens(n)) };
    if (theme) {
      const key = `${kind}:${theme.id}`;
      let c = byKey.get(key);
      if (!c) { c = { key, kind, theme: theme.id, title: theme.title, severity: theme.sev, entries: [], tok: new Set() }; byKey.set(key, c); clusters.push(c); }
      c.entries.push(entry);
    } else pending.push(entry);
  }
  for (const e of pending) {
    let best = null, bs = 0;
    for (const c of clusters) {
      if (c.kind !== e.kind || c.theme) continue;
      const s = jaccard(e.tok, c.tok);
      if (s > bs) { bs = s; best = c; }
    }
    if (best && bs >= 0.34) { best.entries.push(e); e.tok.forEach((w) => best.tok.add(w)); continue; }
    const c = { key: `${e.kind}:free:${clusters.length}`, kind: e.kind, theme: "", title: "", severity: e.kind === "fix" ? 1 : 0, entries: [e], tok: new Set(e.tok) };
    clusters.push(c);
  }

  const fixRows = clusters.filter((c) => c.kind === "fix").reduce((a, c) => a + c.entries.length, 0);
  const upgradeRows = clusters.filter((c) => c.kind === "upgrade").reduce((a, c) => a + c.entries.length, 0);
  const totals = { fixRows, upgradeRows };

  const items = clusters.map((c, idx) => {
    const rs = c.entries.map((e) => e.r).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const users = new Set(rs.map((r) => r.anonymous_id || r.id)).size;
    const rated = rs.map((r) => Number(r.rating)).filter((n) => n > 0);
    const avg = rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : 0;
    const apps = [...new Set(rs.map((r) => r.app_id))];
    const versions = [...new Set(rs.map((r) => r.version).filter(Boolean))];
    const title = c.title || String(rs[0].message).replace(/\s+/g, " ").slice(0, 80);
    const item = {
      id: "IN" + String(idx + 1).padStart(3, "0"), kind: c.kind, theme: c.theme, title,
      count: rs.length, users, avg_rating: avg, apps, versions,
      first_at: rs[rs.length - 1].created_at, last_at: rs[0].created_at,
      recent: rs.filter((r) => now - new Date(r.created_at).getTime() < 7 * 864e5).length,
      severity: c.severity, feedback_ids: rs.map((r) => r.id).slice(0, 20),
      samples: rs.slice(0, 3).map((r) => String(r.message).replace(/\s+/g, " ").slice(0, 160)),
    };
    item.priority = priorityOf({ ...item, kind: c.kind }, totals);
    item.suggested_action = actionOf(item);
    return item;
  });

  // MOST REQUESTED FIRST. Ties: more distinct users, higher severity, fix before upgrade, newest.
  const cmp = (a, b) => b.count - a.count || b.users - a.users || b.severity - a.severity || (a.kind === b.kind ? 0 : a.kind === "fix" ? -1 : 1) || String(b.last_at).localeCompare(String(a.last_at));
  const ranked = items.sort(cmp).map((x, i) => ({ ...x, rank: i + 1 }));
  const fixes = ranked.filter((x) => x.kind === "fix").map((x, i) => ({ ...x, rank: i + 1 }));
  const upgrades = ranked.filter((x) => x.kind === "upgrade").map((x, i) => ({ ...x, rank: i + 1 }));

  const ratings = used.map((r) => Number(r.rating)).filter((n) => n > 0);
  return {
    generated_at: new Date(now).toISOString(),
    scope: { app_id: appId || null, include_closed: includeClosed },
    totals: {
      analyzed: used.length, closed_skipped: skipped, praise: praiseRows.length,
      fix_themes: fixes.length, upgrade_themes: upgrades.length,
      avg_rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : 0,
    },
    fixes, upgrades, ranked,
    builder_prompt: builderPrompt(appId, fixes, upgrades),
    classifier: "local",
  };
}

export function builderPrompt(appId, fixes, upgrades) {
  const line = (x) => `${x.rank}. [${x.priority}] ${x.title} — ${x.count} phản hồi / ${x.users} người`;
  const f = fixes.slice(0, 5).map(line).join("\n") || "(không có)";
  const u = upgrades.slice(0, 5).map(line).join("\n") || "(không có)";
  return `App: ${appId || "(tất cả app)"}\nVấn đề cần sửa (nhiều người báo nhất trước):\n${f}\n\nĐề xuất nâng cấp (nhiều người yêu cầu nhất trước):\n${u}\n\nYêu cầu: phân tích mã nguồn hiện tại, tìm nguyên nhân gốc của các lỗi trên theo đúng thứ tự, đề xuất thay đổi nhỏ nhất an toàn, rồi build, smoke test, HTTP test và preview. Không thêm tính năng ngoài danh sách.`;
}

// AI may only re-word text. Order, counts, kinds, ids always come from buildInsights().
export function applyAiWording(report, aiItems) {
  if (!Array.isArray(aiItems)) return report;
  const map = new Map(aiItems.filter((x) => x && typeof x.id === "string").map((x) => [x.id, x]));
  const patch = (list) => list.map((it) => {
    const a = map.get(it.id);
    if (!a) return it;
    const cut = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : "");
    return { ...it, title: cut(a.title, 120) || it.title, summary: cut(a.summary, 300) || undefined, suggested_action: cut(a.suggested_action, 300) || it.suggested_action };
  });
  const ranked = patch(report.ranked);
  const byId = new Map(ranked.map((x) => [x.id, x]));
  const re = (list) => list.map((x) => ({ ...byId.get(x.id), rank: x.rank }));
  return { ...report, ranked, fixes: re(report.fixes), upgrades: re(report.upgrades), classifier: "kernel" };
}
