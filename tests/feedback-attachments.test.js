import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createFeedbackAttachmentService } from "../lib/feedback-attachments.js";

test("attachment service stores only sniffed safe types under generated names and enforces tenant ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-attachments-"));
  const opened = openDatabase({ dataDir: path.join(root, "db"), migrationsDir: path.resolve("db/migrations") });
  try {
    const apps = createAppService(opened.db);
    for (const id of ["attach-owner", "attach-other"]) { apps.requestRegistration({ app_id: id, app_name: id }); apps.approveApp(id); }
    opened.db.prepare("INSERT INTO feedback(id,application_id,title,message,created_at,record_json) VALUES(?,?,?,?,?,?)").run("FB-1", "attach-owner", "T", "M", new Date().toISOString(), "{}");
    const attachments = createFeedbackAttachmentService({ db: opened.db, uploadDir: path.join(root, "uploads") });
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const saved = attachments.store({ applicationId: "attach-owner", feedbackId: "FB-1", originalName: "../../fake.png", declaredMime: "image/png", bytes: png });
    assert.equal(saved.original_name, "fake.png");
    assert.match(opened.db.prepare("SELECT storage_key FROM feedback_attachments WHERE attachment_id=?").get(saved.attachment_id).storage_key, /^att_[a-f0-9-]+\.png$/);
    assert.equal(attachments.read({ applicationId: "attach-owner", attachmentId: saved.attachment_id }).bytes.equals(png), true);
    assert.throws(() => attachments.read({ applicationId: "attach-other", attachmentId: saved.attachment_id }), { code: "ATTACHMENT_NOT_FOUND" });
    assert.throws(() => attachments.store({ applicationId: "attach-owner", feedbackId: "FB-1", originalName: "fake.png", declaredMime: "image/png", bytes: Buffer.from("<html>bad</html>") }), { code: "UNSAFE_ATTACHMENT" });
  } finally { opened.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
