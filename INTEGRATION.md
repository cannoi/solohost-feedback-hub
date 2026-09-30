# Client integration — schema 2.0

Mọi app SoloHost (và nền tảng sau này) dùng **một** module.

```html
<script src="FEEDBACK_HUB_URL/api/sdk.js"></script>
<script>
const hub = SHFH.create({
  hubUrl: "https://YOUR_PUBLIC_ADDRESS",
  ingestToken: "YOUR_INGEST_TOKEN", // optional if hub allows empty ingest
  appId: "snake-classic",
  appName: "Snake Classic",
  version: "1.2.0",
  platform: "solohost"
});
hub.sendFeedback({ type: "bug", message: "P2 disconnect", rating: 2 });
hub.reportPayment({ txn_id: "TX123", method: "pi", amount: "1" });
const { items } = await hub.pullNotices(); // thanks, payment_ok, unpaid_nudge, update
</script>
```

## Payload chuẩn POST `/api/feedback`

```json
{
  "schema_version": "2.0",
  "event": "feedback",
  "app_id": "snake-classic",
  "app_name": "Snake Classic",
  "version": "1.2.0",
  "platform": "solohost",
  "type": "bug",
  "rating": 2,
  "message": "Player 2 disconnects",
  "anonymous_id": "stable-uuid-kept-locally",
  "license": { "paid": false, "plan": "free", "txn_id": "" },
  "locale": "vi"
}
```

`event`: `feedback` | `payment` | `usage`  
`type`: `bug` | `idea` | `improvement` | `review` | `payment` | `thanks`

Không gửi wallet key / password / seed.

## Client nên poll

- `GET /api/updates?app_id=...` — notice cập nhật đã publish
- `GET /api/notices?app_id=...&anonymous_id=...` — hàng đợi thông báo cá nhân
- `POST /api/notices/:id/read`

## Thanh toán

`event=payment` tạo bản ghi supporter + notice `payment_ok`.  
App đánh dấu `fee_required` trên admin → client chưa `license.paid` sẽ nhận `unpaid_nudge`.

Đây không thay thế luồng xác minh thanh toán Pi. Dùng txn_id từ payment flow sẵn có.

## AI trên Hub

Admin `/admin` chat với kernel. Actions:

- `rank_apps`
- `set_feedback_status`
- `draft_upgrade_plan`
- `publish_update` (vẫn nên review tay)
- `send_notice`

Phân loại local luôn chạy ngay khi ingest. Nút **AI classify** gọi kernel để tinh chỉnh.

## Builder prompt

Feedback chỉ thành task nâng cấp sau khi bạn chọn. Dùng `GET /api/apps/:app_id/plan` lấy `builder_prompt`.
