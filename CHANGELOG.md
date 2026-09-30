# v2.1.0 — 2026-09-30

- `/` mặc định là UI admin (form công khai chuyển sang `/feedback`)
- Đăng nhập mật khẩu + session cookie 12h; lần đầu setup password
- Settings trong dashboard: hub URL, ingest token, donate, AI endpoint, đổi mật khẩu
- Catalog seed 9 app SoloHost thật để quản lý ngay
- API key AI không lưu trong settings.json (vẫn env)

# v2.0.0 — 2026-09-30

- Admin dashboard 3 cột: rank app theo heat/bug/rating, inbox, AI + publish + notice
- Catalog app: thêm thủ công, tự tạo khi có feedback
- Schema client 2.0 + drop-in `shfh-client.js` (`/api/sdk.js`)
- Event payment / notices (thanks, payment_ok, unpaid_nudge, update)
- Tích hợp ai-app-kernel v1.1.2: chat, classify, rewrite, actions
- Upgrade plan + builder_prompt từ feedback mở
- CORS cho app khác origin
- ESM server
