# SoloHost Feedback Hub v2.0

Trung tâm phản hồi + AI trên SoloHost. Nhận feedback từ mọi app, xếp hạng app nóng/lạnh, phân loại bằng AI kernel, xếp hàng nâng cấp, và đẩy thông báo (cảm ơn / thanh toán OK / nhắc ủng hộ) về client.

## Chạy

```bash
docker compose build
docker compose up -d
```

- Admin (mặc định): `http://SOLOHOST-IP:8090` — đăng nhập mật khẩu
- Form công khai: `http://SOLOHOST-IP:8090/feedback`
- Admin alias: `http://SOLOHOST-IP:8090/admin`
- SDK: `http://SOLOHOST-IP:8090/api/sdk.js`

Đặt `ADMIN_TOKEN` và `INGEST_TOKEN` dài, ngẫu nhiên. AI dùng `ai-app-kernel` (auto provider từ token / local OpenAI-compatible).

## Dữ liệu

`data/apps.json` `feedback.json` `updates.json` `notices.json` `payments.json`

## Bảo mật

Không privileged, không Docker socket, không lộ `/app/data`. Public HTTP nên đứng sau HTTPS khi mở Internet.
