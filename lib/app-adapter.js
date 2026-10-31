/**
 * App Adapter for SoloHost Feedback Hub
 * Provides knowledge, context, safe actions and offline localReply for the Universal AI Panel.
 */
export const knowledge = `
APP NAME: SoloHost Feedback Hub (SHFH)
VERSION: 2.5.0 (upgraded with Universal AI + Feedback modules)
PURPOSE: Central feedback, notices, updates and AI insights hub for all SoloHost apps (Snake Arcade, etc.).

MAIN FEATURES:
- Public feedback form at / and /feedback — anyone can send bug/idea/improvement/review without account.
- Admin dashboard at /admin — password protected. Overview of apps, feedback list, AI insights, notices, updates, settings.
- Client SDK at /api/sdk.js (SHFH.create) for apps to send feedback, pull notices, report payments.
- AI classification of incoming feedback (priority, sentiment, suggested action).
- AI Insights / ranking of apps by heat, open bugs, ratings.
- Notices system (thanks, payment_ok, unpaid_nudge, update, custom).
- Donate info (Pi wallet + MB Bank) returned to clients from Hub policy; never hard-coded in client apps.
- Settings: Hub ID, Public Base URL, Ingest Token, AI provider/key/model/local URL, admin password, donate details.

SCREENS / UI:
- Public: feedback form + updates list + donate buttons (Pi / bank).
- Admin: left apps list + KPIs, center feedback list + insights, right AI panel (now Universal FAB), notices, updates, settings form.
- AI Panel (robot FAB bottom-right): tabs Chat | Feedback | Settings | Logs. Same as Snake Arcade.

HOW TO USE (admin):
1. First boot: open /admin, set admin password.
2. Configure Hub ID, Public Base URL, Ingest Token in Settings (or they come from env / defaults).
3. Optional: set AI API key + provider for cloud models; or Local/Ollama Base URL.
4. View feedback, change status (NEW → REVIEWING → PLANNED → IN_PROGRESS → DONE / DECLINED).
5. Use AI Insights button for summary of all feedback by topic.
6. Publish updates or send notices to apps.
7. Clients integrate once with the SDK; donate accounts always come from this Hub sync.

AI PANEL (Universal system — THE ONLY AI KEY INPUT):
- One floating robot button (bottom-right). Badge shows unread notices count only when >0.
- Chat works offline via localReply when no API key.
- Full providers: OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local.
- Feedback tab: send feedback + see notices from this same Hub; donate loaded from sync.
- Settings tab: THE ONLY place to enter AI API key / provider / model / Base URL. Save / Check token / Refresh models.
- Admin Settings page no longer has AI key fields (Hub ID / Donate / Password only).
- Insights rewrite and classify also use this same Universal AI key store.
- Logs: recent AI and system events.

LANGUAGE: App UI is Vietnamese + English labels. AI replies in the language the user writes (vi or en).

SECURITY:
- Ingest token only server-side.
- API keys stored in data/ (masked on GET).
- No secrets in client JS or AI prompts.
- Admin session cookie required for dashboard and settings write.

COMMON USER QUESTIONS:
- How to integrate an app? → Use /api/sdk.js, call SHFH.create({hubUrl, ingestToken, appId, appName, version}).
- Where is the public form? → / or /feedback.
- How to change donate info? → Admin Settings → Donate section.
- Why badge on robot? → Unread notices from Feedback Hub for this app identity.
- Chat empty? → Save an API key in Settings tab, or ask offline questions (localReply covers help, features, how-to).
`;

export const actions = [
  { name: 'open_tab', description: 'Open AI panel tab: chat, feedback, settings or logs' },
  { name: 'refresh_overview', description: 'Refresh admin overview / feedback list (client side)' },
  { name: 'show_settings', description: 'Open admin settings panel' },
];

const ALLOWED = new Set(actions.map(a => a.name));

export async function getContext(ctx = {}) {
  return {
    screen: ctx.screen || 'admin',
    currentApp: ctx.currentApp || null,
    hubId: process.env.HUB_ID || 'SHFH-CANNOI-0905428801',
    version: '2.5.0',
    hasAiKey: Boolean(process.env.AI_API_KEY),
  };
}

export async function executeAction({ name, args } = {}) {
  const n = String(name || '');
  if (!ALLOWED.has(n)) return { ok: false, error: 'Action not allowed' };
  return { ok: true, action: n, value: (args && args.value) || '', client_execute: true };
}

export async function localReply(message, live = {}) {
  const m = String(message || '').toLowerCase().trim();
  if (!m) return 'Xin chào! Tôi là trợ lý AI của SoloHost Feedback Hub. Hỏi về cách dùng, tích hợp SDK, feedback, notices hoặc settings.';

  // Vietnamese
  if (/cách dùng|hướng dẫn|help|how to|làm sao|giúp/.test(m)) {
    return 'Admin: mở /admin, đặt mật khẩu lần đầu. Cấu hình Hub ID / URL / Token trong Settings. Xem feedback, đổi status, bấm AI Insights để tổng hợp. Public form: /feedback. Tích hợp app: script /api/sdk.js rồi SHFH.create({hubUrl, ingestToken, appId, appName, version}).';
  }
  if (/tích hợp|sdk|integrate|client|app/.test(m)) {
    return 'Trong app client: <script src="HUB_URL/api/sdk.js"></script> rồi const hub = SHFH.create({ hubUrl, ingestToken, appId, appName, version, platform: "solohost" }); hub.sendFeedback({type, message, rating}); await hub.pullNotices(); Donate và notices luôn lấy từ Hub, không hard-code.';
  }
  if (/feedback|góp ý|phản hồi|bug|idea/.test(m)) {
    return 'Tab Feedback trong nút robot (hoặc form /feedback): chọn loại (bug/idea/improvement/review), điểm, nội dung. Không gửi mật khẩu/API key/seed. Admin xem danh sách, đổi status, dùng AI Insights.';
  }
  if (/notice|thông báo|badge|unread|đọc/.test(m)) {
    return 'Notices (thanks, payment_ok, unpaid_nudge, update…) được Hub đẩy cho từng app + anonymous_id. Client poll /api/notices, mark read bằng POST /api/notices/:id/read. Badge trên nút robot chỉ hiện khi có unread > 0.';
  }
  if (/donate|ủng hộ|pi|bank|ví|chuyển khoản/.test(m)) {
    return 'Thông tin ủng hộ (Pi wallet + MB Bank) nằm trong Settings của Hub và được trả về qua client-policy / sync. Không hard-code trong source client. Admin sửa trong Settings → Donate.';
  }
  if (/setting|cài đặt|api key|provider|model|local|ollama/.test(m)) {
    return 'Tab Settings của AI Panel: chọn provider (OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local), dán API key, Base URL nếu Custom/Local, chọn model, Save. Check token để kiểm tra. Key chỉ lưu server-side, GET trả masked.';
  }
  if (/insight|tổng hợp|xếp hạng|heat|ranking/.test(m)) {
    return 'Trong admin bấm «AI tổng hợp» để gom feedback theo chủ đề, tách Cần sửa / Đề xuất nâng cấp, xếp app theo heat (feedback + bugs + rating).';
  }
  if (/admin|mật khẩu|password|đăng nhập/.test(m)) {
    return 'Lần đầu mở /admin sẽ yêu cầu đặt mật khẩu. Session cookie HttpOnly. Không có tài khoản user riêng — chỉ một admin password.';
  }
  if (/port|cổng|docker|compose|chạy/.test(m)) {
    return 'Mặc định PORT 8090. docker compose up -d. data/ chứa settings + DB. Config non-secret: config/solohost.json; secrets: config/solohost.env hoặc Settings UI.';
  }

  // English fallbacks
  if (/hello|hi |what can|who are/.test(m)) {
    return 'I am the AI assistant for SoloHost Feedback Hub. Ask about admin usage, SDK integration, feedback flow, notices, donate, or AI Settings. I reply in the language you use.';
  }
  if (/version|what is this/.test(m)) {
    return 'SoloHost Feedback Hub v2.5 with Universal AI Panel (Chat / Feedback / Settings / Logs) + classic classification & insights. One robot button bottom-right.';
  }

  return live && live.currentApp
    ? `Đang xem app "${live.currentApp}". Bạn có thể hỏi về feedback của app này, cách đổi status, hoặc gửi notice. (Offline reply — thêm API key ở tab Settings để dùng model đầy đủ.)`
    : 'Tôi hiểu câu hỏi nhưng cần thêm ngữ cảnh. Hỏi về: cách dùng admin, tích hợp SDK, feedback, notices, donate, AI Settings, hoặc Insights. (Trả lời offline — cấu hình API key để dùng AI mạnh hơn.)';
}

export default {
  knowledge,
  actions,
  getContext,
  executeAction,
  localReply,
};
