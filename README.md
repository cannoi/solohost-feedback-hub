# SoloHost Feedback Hub v2.3

Trung tâm phản hồi + AI trên SoloHost.

## Config SoloHost (2 file)

- `config/solohost.json` — metadata không secret
- `config/solohost.env` — env tùy chọn (PORT, HUB_ID, …)

Lần đầu chỉ cần mở app và **đặt mật khẩu**. Token AI / donate / ingest điền trong Settings.

```bash
docker compose build
docker compose up -d
```

- Admin: `http://SOLOHOST-IP:8090`
- Form công khai: `http://SOLOHOST-IP:8090/feedback`
- SDK: `http://SOLOHOST-IP:8090/api/sdk.js`
- Module + hướng dẫn: `module/`

## Dữ liệu

`data/` — apps, feedback, updates, notices, payments, settings (hash mật khẩu + key AI).

