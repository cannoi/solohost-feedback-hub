/**
 * SoloHost Feedback Hub adapter for the Universal AI Panel.
 * The knowledge document is the single maintained source for panel guidance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const knowledgeFile = path.resolve(here, '../docs/AI-PANEL-KNOWLEDGE.md');
export const knowledge = fs.readFileSync(knowledgeFile, 'utf8');

export const actions = [
  { name: 'open_tab', description: 'Open one of the AI Panel tabs: chat, feedback, settings, or logs.' },
];

const allowedTabs = new Set(['chat', 'feedback', 'settings', 'logs']);

export async function getContext(ctx = {}) {
  return {
    screen: String(ctx.screen || 'admin').slice(0, 80),
    currentApp: ctx.currentApp ? String(ctx.currentApp).slice(0, 120) : null,
    hubId: process.env.SHFH_HUB_ID || process.env.HUB_ID || 'SHFH-CANNOI-0905428801',
    appVersion: '2.5.1',
    aiConfigured: true, // The server determines provider readiness; never expose key material.
  };
}

export async function executeAction({ name, args } = {}) {
  if (name !== 'open_tab') return { ok: false, error: 'Action not allowed' };
  const tab = String(args?.tab || args?.value || 'chat');
  if (!allowedTabs.has(tab)) return { ok: false, error: 'Unknown panel tab' };
  return { ok: true, action: 'open_tab', value: tab, client_execute: true };
}

function detectLanguage(message) {
  const s = String(message || '');
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(s) ||
    /\b(xin chào|hướng dẫn|cách dùng|làm sao|tôi|bạn|góp ý|phản hồi|thông báo|cài đặt|đăng nhập|không|được|giúp)\b/i.test(s)
    ? 'vi' : 'en';
}

export async function localReply(message, live = {}) {
  const m = String(message || '').toLowerCase().trim();
  const vi = detectLanguage(message) === 'vi';
  if (!m) return vi
    ? 'Xin chào! Tôi là trợ lý của SoloHost Feedback Hub. Bạn có thể hỏi cách dùng, gửi phản hồi, quản lý thông báo hoặc cấu hình AI.'
    : 'Hello! I’m the SoloHost Feedback Hub assistant. Ask about using the app, submitting feedback, managing notices, or configuring AI.';

  const topic = /sdk|tích hợp|integrat|client|api/.test(m) ? 'integration'
    : /feedback|góp ý|phản hồi|bug|idea/.test(m) ? 'feedback'
    : /approve|approval|pending|chờ duyệt|phê duyệt|xóa app|delete app|remove app/.test(m) ? 'apps'
    : /notice|thông báo|badge|unread|đã đọc/.test(m) ? 'notices'
    : /donate|ủng hộ|pi wallet|ngân hàng|bank/.test(m) ? 'donate'
    : /setting|cài đặt|api key|provider|model|local|ollama/.test(m) ? 'settings'
    : /insight|tổng hợp|xếp hạng|ranking/.test(m) ? 'insights'
    : /owner|chủ ứng dụng|application owner/.test(m) ? 'owner'
    : /admin|mật khẩu|password|đăng nhập|login/.test(m) ? 'admin'
    : /docker|compose|port|cổng|deploy|triển khai/.test(m) ? 'deploy'
    : /version|phiên bản|what is this|app này/.test(m) ? 'version'
    : /hello|hi\b|xin chào|chào/.test(m) ? 'hello'
    : 'general';

  const answers = {
    vi: {
      integration: 'Tích hợp ứng dụng qua SDK tại /api/sdk.js. Dùng app ID và credential riêng cho từng ứng dụng; chỉ cấu hình ingest token ở phía server, không đưa vào trình duyệt. Xem INTEGRATION.md và docs/API-v1.md.',
      feedback: 'Bạn có thể gửi phản hồi qua form công khai hoặc tab Feedback trong panel AI. Không gửi mật khẩu, API key, token hay seed phrase. Quản trị viên xem phản hồi trong /admin và cập nhật trạng thái.',
      apps: 'Ứng dụng mới gửi phản hồi lần đầu sẽ ở trạng thái chờ duyệt và chưa xuất hiện trong danh sách app đang quản lý. Admin duyệt tại /admin. App chờ duyệt chỉ được gửi tối đa 1 phản hồi mỗi giờ trên mỗi client và 5 phản hồi mỗi ngày trên toàn app; đăng ký mới giới hạn 3 app mỗi IP mỗi ngày và hàng chờ tối đa 100 app. Xóa app sẽ vô hiệu hóa credential và ẩn app, nhưng giữ phản hồi/lịch sử.',
      notices: 'Thông báo được quản lý trong Hub và đồng bộ theo ứng dụng/người dùng. Badge chỉ hiện khi có thông báo chưa đọc; mở tab Feedback để xem và bấm “Đã đọc” trên từng thông báo.',
      donate: 'Thông tin ủng hộ chỉ hiển thị khi được Hub trả về trong dữ liệu sync. Ứng dụng không nên hard-code địa chỉ ví hoặc tài khoản ngân hàng.',
      settings: 'Trong tab Settings của AI Panel, chọn provider, nhập API key nếu cần, đặt Base URL cho Custom/Local, chọn model rồi Save. Dùng Check token và Load models để kiểm tra. API key được lưu phía server và chỉ hiển thị dạng đã che.',
      insights: 'Trong trang Admin, dùng AI Insights để tổng hợp phản hồi theo chủ đề và ưu tiên. Kết quả AI là gợi ý; hãy xác minh trước khi hành động.',
      owner: 'Trang Application owner cho phép chủ ứng dụng quản lý các ứng dụng được cấp quyền. Đăng nhập bằng lời mời từ quản trị viên nền tảng.',
      admin: 'Mở /admin để đăng nhập quản trị. Lần chạy đầu tiên có thể yêu cầu thiết lập mật khẩu. Không chia sẻ mật khẩu hoặc credential qua chat.',
      deploy: 'Ứng dụng mặc định dùng cổng 8090. Dữ liệu runtime nằm trong thư mục data/. Kiểm tra docker-compose.yml, config_options.yml và hướng dẫn triển khai của bản SoloHost đang dùng.',
      version: 'SoloHost Feedback Hub 2.5.1 có form phản hồi, quản trị nhiều ứng dụng, thông báo, owner dashboard, API/SDK, AI Insights và một AI Panel gồm Chat, Feedback, Settings, Logs.',
      hello: 'Xin chào! Tôi có thể hướng dẫn sử dụng Hub, SDK, phản hồi, thông báo, AI Settings và triển khai.',
      general: `Tôi có thể hướng dẫn về quản trị Hub, tích hợp SDK, phản hồi, thông báo, AI Settings hoặc triển khai. ${live?.currentApp ? `Ứng dụng đang chọn: ${String(live.currentApp).slice(0, 100)}.` : ''} Khi có kết nối AI, hãy cấu hình provider trong Settings để nhận câu trả lời sâu hơn.`,
    },
    en: {
      integration: 'Integrate an app through the SDK at /api/sdk.js. Use a separate app ID and credential for each app; configure ingest credentials server-side only, never in browser code. See INTEGRATION.md and docs/API-v1.md.',
      feedback: 'Submit feedback through the public form or the AI Panel’s Feedback tab. Never include passwords, API keys, tokens, or seed phrases. Administrators can review submissions at /admin and update their status.',
      apps: 'An app discovered through its first feedback submission remains pending and is excluded from the managed app list until an administrator approves it at /admin. Pending apps are limited to one feedback submission per client per hour and five per app per day; new registrations are limited to three per IP per day and the approval queue is capped at 100. Removing an app disables its credentials and hides it while retaining feedback and history.',
      notices: 'Notices are managed by the Hub and synced by app/user. The badge appears only for unread notices; open the Feedback tab and mark each notice as read.',
      donate: 'Donation details appear only when returned by the Hub sync response. Do not hard-code wallet addresses or bank account details in an app.',
      settings: 'In the AI Panel Settings tab, choose a provider, enter an API key if needed, set the Base URL for Custom/Local, choose a model, then Save. Use Check token and Load models to verify. Keys are stored server-side and masked in responses.',
      insights: 'Use AI Insights in the Admin page to summarize feedback by topic and priority. AI output is advisory; verify it before taking action.',
      owner: 'The Application owner page lets owners manage applications assigned to their account. Sign in using an invitation from the platform administrator.',
      admin: 'Open /admin to sign in as an administrator. First-run setup may ask you to create a password. Never share passwords or credentials in chat.',
      deploy: 'The app defaults to port 8090. Runtime data is stored in data/. Check docker-compose.yml, config_options.yml, and the deployment instructions for your SoloHost version.',
      version: 'SoloHost Feedback Hub 2.5.1 includes public feedback, multi-app administration, notices, an owner dashboard, API/SDK, AI Insights, and one AI Panel with Chat, Feedback, Settings, and Logs.',
      hello: 'Hello! I can help with Hub administration, SDK integration, feedback, notices, AI Settings, and deployment.',
      general: `I can help with Hub administration, SDK integration, feedback, notices, AI Settings, or deployment. ${live?.currentApp ? `Currently selected app: ${String(live.currentApp).slice(0, 100)}.` : ''} Configure a provider in Settings for more detailed AI assistance.`,
    },
  };
  return answers[vi ? 'vi' : 'en'][topic];
}

export default { knowledge, actions, getContext, executeAction, localReply };
