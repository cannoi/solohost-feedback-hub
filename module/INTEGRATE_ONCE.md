# Tích hợp chuẩn — SoloHost Feedback Hub

File kèm: `shfh-client.js`  
Khuyến nghị load từ Hub để sau này chỉ nâng cấp Hub:

```html
<script src="http://SOLOHOST-IP:8090/api/sdk.js"></script>
```

Hoặc copy `shfh-client.js` vào app (offline).

## Bước 1 — trên Hub

1. Mở `http://SOLOHOST-IP:8090`
2. Đặt mật khẩu admin (lần đầu)
3. Settings: Public URL, Ingest token (nếu muốn khóa API), Donate, AI
4. Thêm app (`app_id` cố định) hoặc đợi client gửi feedback lần đầu

## Bước 2 — trong app (một lần)

```js
const hub = SHFH.create({
  hubUrl: "http://SOLOHOST-IP:8090",
  ingestToken: "",          // trùng Settings → Ingest token (có thể để trống)
  appId: "my-app-id",
  appName: "My App",
  version: "1.0.0",
  platform: "solohost",
  locale: "vi"
});

const snap = await hub.sync();
// snap.payment.state: free | unpaid | pending | supporter | expired | waived | unknown
// snap.update.needed  — version Hub > version app HOẶC ngày publish > ngày cài
// snap.actions        — update | unpaid_nudge | payment_ok | thanks
// snap.donate         — Pi / MB Bank từ Hub

await hub.sendFeedback({ type: "bug", message: "mô tả", rating: 2 });
await hub.reportPayment({ txn_id: "TX", method: "pi", amount: "1" });
if (snap.update.item) hub.markUpdateSeen(snap.update.item.id);
```

Gọi `hub.sync()` lúc mở app. Mất mạng: feedback xếp hàng local.

## Không gửi

mật khẩu, API key, seed phrase, private key.

## Nâng cấp sau

Đổi phí / câu thông báo / update / donate trên Hub. App không cần sửa nếu đang load `/api/sdk.js`.
