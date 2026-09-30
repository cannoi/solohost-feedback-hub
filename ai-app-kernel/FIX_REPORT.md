# AI App Kernel v1.1.2 — Security + Fix Report

## Bảo mật (xác nhận báo cáo người dùng)

Kernel 1.1.0/1.1.1 gửi cùng khóa người dùng nhập sang mọi nhà khi fallback (`apiKey || keys[provider]`) và `envKey()` lấy OPENAI_API_KEY cho mọi provider. Tái hiện: khóa OpenAI 401 rồi POST tới api.deepseek.com.

### Sửa phía tác giả kernel (v1.1.2)

- `keyBelongsToProvider(token, provider)` — chỉ true khi prefix khớp nhà đó.
- Vòng fallback bỏ qua nhà không có khóa riêng; không gửi Bearer chéo host.
- `envKey(id)` chỉ đọc `${ID}_API_KEY`; AI_API_KEY chỉ khi hint khớp; OPENAI_API_KEY chỉ cho openai.
- Adapter (mỗi khóa một biến môi trường đúng nhà) vẫn đúng và được khuyến nghị.
- Self-test mock fetch: khóa sk-proj không đụng DeepSeek/Groq. 27/27 passed.

# AI App Kernel v1.1.1 — Fix Report

Nguồn đối chiếu: `ai-app-kernel` v1.1.0 (gói tải lên) + bản đã vá trong Snake Arcade v2.8 + App Builder (token chạy ổn).

## Lỗi / thiếu sót tìm thấy ở MODULE v1.1.0

1. **Token dán trực tiếp không được nhận diện nhà cung cấp**  
   `createAiKernel({ apiKey })` không gọi `detectProviderFromToken`. Token `gsk_` / `AIza` / `xai-` / `sk-or-` bị gán nhầm provider đầu tiên (thường `openai`) → API trả 401/404. App Builder ổn vì nó chọn provider trước khi gọi.

2. **`POST /ai/act` luôn lỗi khi mount**  
   `mount()` không truyền `kernel.invoke`. `http.js` gọi `kernel.invoke(...)` → TypeError. Đây là lỗi chắc chắn ở mọi app chỉ dùng `ai.mount(app, '/ai')`.

3. **Khóa model khi có `AI_MODEL` / `options.model`**  
   Nếu model cũ/sai (Gemini 1.5, tên đã nghỉ), kernel dừng luôn, không thử model khác, không gọi `/models`.

4. **Catalog Gemini lỗi thời**  
   Mặc định `gemini-2.0-flash` / `gemini-1.5-flash` dễ 404. Snake đã chuẩn hóa `gemini-2.5-flash`.

5. **Không fallback sang provider khác** khi billing/auth/rate-limit.

6. **Lỗi raw HTTP** trả về JSON provider (dễ lộ chi tiết, khó hiểu). Thiếu `friendlyAiError` / `classifyProviderError`.

7. **Không discover model** sau khi catalog tĩnh thất bại.

## Đã làm (v1.1.1)

- Nhận diện provider từ token khi `apiKey` được truyền.
- Fallback model trong cùng provider; sau đó discover `/models` (OpenAI-compat, Gemini, Ollama, LM Studio).
- Fallback provider theo `PROVIDER_PRIORITY` khi còn key.
- Chuẩn hóa model Gemini (1.5 / gemini-pro → `gemini-2.5-flash`).
- `mount()` truyền `invoke`; `/ai/act` fallback sang `actions.invoke`.
- HTTP trả `kind` + thông báo song ngữ; 502 cho auth/billing.
- Export thêm: `detectProviderFromToken`, `classifyProviderError`, `friendlyAiError`, `normalizeModel`.
- Self-test thêm: mount `/ai/act`, `/ai/health`, invoke qua HTTP mock.
- Version `1.1.1`. Logo, tools, store, actions, schema, INTEGRATE mục tiêu giữ nguyên.

## Không làm / không đổi

- Không sửa App Builder (`app-builder-pi-solohost-v1.4.59`) — token AI trong App Builder đã ổn.
- Không sửa gameplay / UI Snake trong gói này (Snake chỉ dùng để đối chiếu lỗi).
- Không thêm Anthropic / Claude (không có trong catalog gốc).
- Không gọi thật cloud provider (không có key người dùng trong môi trường này).
- Không đổi contract schema / tool names (`app_schema`, `db_list`, `app_invoke`, …).

## Kiểm tra

Chạy: `node src/selftest.js` trong thư mục module.
