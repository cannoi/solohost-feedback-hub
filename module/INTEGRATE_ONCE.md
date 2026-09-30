# Tích hợp một lần — module SHFH v2.2

Copy `module/shfh-client.js` vào app **hoặc** load từ Hub để luôn nhận bản mới:

```html
<script src="http://SOLOHOST-IP:8090/api/sdk.js"></script>
```

Load từ Hub = nâng cấp sau này **chỉ sửa Feedback Hub**. App không cần rebuild khi đổi câu thông báo, cờ phí, hay rule update.

## 1. Khởi tạo (mọi app)

```js
const hub = SHFH.create({
  hubUrl: "http://SOLOHOST-IP:8090",
  ingestToken: "YOUR_INGEST_TOKEN", // lấy từ Settings Hub
  appId: "snake-classic",           // đúng catalog trên Hub
  appName: "Snake Classic",
  version: "1.2.0",                 // version app đang chạy
  platform: "solohost",
  locale: "vi"
});
```

`installed_at` được ghi local lần đầu mở app. Không gửi seed/password.

## 2. Một hàm cho mọi kịch bản: `hub.sync()`

Gọi khi app mở và mỗi 6–12 giờ.

```js
const snap = await hub.sync();
for (const a of snap.actions) {
  if (a.kind === "update") showUpdate(a.update);
  if (a.kind === "unpaid_nudge") showDonate(snap.donate);
  if (a.kind === "payment_ok") showThanks();
  if (a.kind === "thanks") showToast(a.title);
  if (a.id) hub.markRead(a.id);
}
if (snap.update.needed && snap.update.item) {
  // so sánh: version Hub > version app  HOẶC  ngày publish > ngày cài
  // snap.update.newerVer / publishedAfterInstall / installedAt
}
```

## 3. Trạng thái thanh toán (client tự giữ + Hub xác nhận)

| state | Nghĩa | Thông báo |
|---|---|---|
| free | App không thu phí (`fee_required=false` trên Hub) | không nhắc ủng hộ bắt buộc |
| unpaid | Cần phí, chưa trả | `unpaid_nudge` |
| pending | User vừa bấm ủng hộ, chờ Hub | không spam nudge |
| paid / supporter | Đã ghi nhận | `payment_ok` một lần |
| expired | `paid_until` hết hạn | `unpaid_nudge` |
| waived | Admin miễn | không nhắc |
| unknown | chưa có policy | chờ `sync()` |

```js
hub.reportPayment({ txn_id, method: "pi", amount: "1" }); // → pending rồi supporter nếu Hub 201
hub.setPaymentState("waived");
```

Cờ `fee_required` **đặt trên Hub**, không hard-code trong app.

## 4. Cập nhật: ngày cài vs ngày publish

Thông báo update khi **một** điều đúng:

1. `latest.version` > version app đang chạy  
2. `latest.created_at` > `installed_at` (bản publish sau ngày user cài)

Không báo nếu user đã `markUpdateSeen(id)` hoặc đã ở đúng version.

## 5. Gửi feedback

```js
await hub.sendFeedback({ type: "bug", message: "P2 drop", rating: 2 });
```

Mất mạng → xếp hàng local, `sync()`/`flushQueue()` gửi sau.

## 6. UI gợi ý trong app

- 💬 Feedback  
- 🆕 Updates (`snap.update`)  
- 💛 Donate (`snap.donate`)  

Tách khỏi chức năng chính của app.

## 7. Không làm

- Không nhúng ADMIN_TOKEN  
- Không gửi ví / seed / password  
- Không tự tin thanh toán Pi đã verified — Hub ghi nhận `txn_id`, verifier Pi vẫn là app của bạn
