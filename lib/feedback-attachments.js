import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const TYPES = Object.freeze({
  "image/png": { extension: "png", detect: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  "image/jpeg": { extension: "jpg", detect: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { extension: "webp", detect: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  "application/pdf": { extension: "pdf", detect: (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-" },
});

function failure(code, message) { return Object.assign(new Error(message), { code }); }

export function createFeedbackAttachmentService({ db, uploadDir, clock = () => new Date() }) {
  if (!db || !uploadDir) throw new TypeError("db and uploadDir are required");
  const root = path.resolve(uploadDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  function store({ applicationId, feedbackId, originalName, declaredMime, bytes }) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) throw failure("UNSAFE_ATTACHMENT", "Attachment must be between 1 byte and 5 MiB");
    const type = TYPES[declaredMime];
    if (!type || !type.detect(bytes)) throw failure("UNSAFE_ATTACHMENT", "Attachment content does not match an allowed file type");
    const rawName = String(originalName || "attachment").split(/[\\/]/).at(-1);
    const cleanName = rawName.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^\p{L}\p{N}._ -]/gu, "_").trim().slice(0, 120) || `attachment.${type.extension}`;
    const ext = path.extname(cleanName).toLowerCase();
    const compatibleExtension = type.extension === "jpg" ? [".jpg", ".jpeg"].includes(ext) : ext === `.${type.extension}`;
    if (!compatibleExtension) throw failure("UNSAFE_ATTACHMENT", "File extension does not match the detected content type");
    const feedback = db.prepare("SELECT 1 FROM feedback WHERE id=? AND application_id=? AND deleted_at IS NULL").get(feedbackId, applicationId);
    if (!feedback) throw failure("FEEDBACK_NOT_FOUND", "Feedback was not found");
    const attachmentId = `att_${crypto.randomUUID()}`;
    const storageKey = `${attachmentId}.${type.extension}`;
    const target = path.resolve(root, storageKey);
    if (!target.startsWith(`${root}${path.sep}`)) throw failure("UNSAFE_ATTACHMENT", "Invalid attachment storage key");
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    const createdAt = clock().toISOString();
    try {
      db.prepare(`INSERT INTO feedback_attachments(attachment_id, application_id, feedback_id, storage_key, original_name, mime_type, size_bytes, sha256, created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(attachmentId, applicationId, feedbackId, storageKey, cleanName, declaredMime, bytes.length, crypto.createHash("sha256").update(bytes).digest("hex"), createdAt);
    } catch (error) {
      try { fs.unlinkSync(target); } catch {}
      throw error;
    }
    return { attachment_id: attachmentId, feedback_id: feedbackId, original_name: cleanName, mime_type: declaredMime, size_bytes: bytes.length, created_at: createdAt };
  }

  function findForCustomer({ feedbackId, attachmentId }) {
    return db.prepare("SELECT * FROM feedback_attachments WHERE feedback_id=? AND attachment_id=?").get(feedbackId, attachmentId);
  }

  function read({ applicationId, attachmentId, feedbackId }) {
    const row = db.prepare(`SELECT a.* FROM feedback_attachments a JOIN feedback f ON f.id=a.feedback_id AND f.application_id=a.application_id
      WHERE a.attachment_id=? AND a.application_id=? AND f.deleted_at IS NULL`).get(attachmentId, applicationId);
    if (!row || (feedbackId && row.feedback_id !== feedbackId)) throw failure("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    if (!/^att_[0-9a-f-]{36}\.(png|jpg|webp|pdf)$/.test(row.storage_key)) throw failure("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    const target = path.resolve(root, row.storage_key);
    if (!target.startsWith(`${root}${path.sep}`)) throw failure("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    let bytes;
    try { bytes = fs.readFileSync(target); } catch { throw failure("ATTACHMENT_NOT_FOUND", "Attachment was not found"); }
    if (bytes.length !== row.size_bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw failure("ATTACHMENT_CORRUPT", "Attachment integrity check failed");
    return { bytes, mime_type: row.mime_type, original_name: row.original_name, size_bytes: row.size_bytes };
  }

  function readForCustomer({ feedbackId, attachmentId }) {
    const row = findForCustomer({ feedbackId, attachmentId });
    if (!row) throw failure("ATTACHMENT_NOT_FOUND", "Attachment was not found");
    return read({ applicationId: row.application_id, attachmentId, feedbackId });
  }

  function storageKeys({ applicationId, feedbackId }) {
    return db.prepare("SELECT storage_key FROM feedback_attachments WHERE application_id=? AND feedback_id=?").all(applicationId, feedbackId).map((row) => row.storage_key);
  }

  function removeStorageKeys(keys) {
    let removed = 0;
    for (const key of keys) {
      if (!/^att_[0-9a-f-]{36}\.(png|jpg|webp|pdf)$/.test(String(key))) continue;
      const target = path.resolve(root, key);
      if (!target.startsWith(`${root}${path.sep}`)) continue;
      try { fs.unlinkSync(target); removed += 1; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return removed;
  }

  return Object.freeze({ store, read, readForCustomer, storageKeys, removeStorageKeys });
}
