import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "../lib/db.js";
import { createAppService } from "../lib/apps.js";
import { createSecretBox } from "../lib/secret-box.js";
import { createPiPaymentService } from "../lib/pi-payments.js";
import { createFeeLedgerService } from "../lib/fee-ledger.js";

const makePayment = (overrides = {}) => ({ identifier: "pi_payment_01", user_uid: "pi_user_1", amount: 1.25, memo: "Order 42", metadata: { hub_session_id: "PS-1", item: "pro" }, direction: "user_to_app", network: "Pi Testnet", status: { developer_approved: false, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false }, transaction: null, ...overrides });
function setup({ linkedFeeOrder = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shfh-pi-payments-"));
  const opened = openDatabase({ dataDir, migrationsDir: path.resolve("db/migrations") });
  const apps = createAppService(opened.db); apps.requestRegistration({ app_id: "pi-workflow", app_name: "Pi Workflow" }); apps.approveApp("pi-workflow");
  const feeLedger = createFeeLedgerService({ db: opened.db });
  const feeOrder = linkedFeeOrder ? feeLedger.createOrder({ applicationId: "pi-workflow", idempotencyKey: "pi-order-reference-42", amountSubunits: 12500000, amountScale: 7, currency: "PI", provider: "pi" }).order : null;
  opened.db.prepare("INSERT INTO payment_sessions(session_id,application_id,idempotency_key,amount_micros,memo,metadata_json,order_reference,status,created_at,updated_at,fee_order_id) VALUES('PS-1','pi-workflow','order-42',12500000,'Order 42','{\"item\":\"pro\"}','42','created',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), feeOrder?.order_id || null);
  let payment = makePayment({ metadata: { hub_session_id: "PS-1", item: "pro", ...(feeOrder ? { fee_order_id: feeOrder.order_id } : {}) } }), approvalCalls = 0, completionCalls = 0, time = new Date("2026-10-31T00:00:00.000Z");
  const client = { verifyUser: async () => ({ uid: "pi_user_1" }), getPayment: async () => payment, approvePayment: async () => { approvalCalls++; payment = { ...payment, status: { ...payment.status, developer_approved: true } }; return payment; }, completePayment: async (_id, txid) => { completionCalls++; payment = { ...payment, status: { ...payment.status, developer_completed: true }, transaction: { txid, verified: true } }; return payment; } };
  const secretBox = createSecretBox(crypto.randomBytes(32).toString("base64url"));
  const service = createPiPaymentService({ db: opened.db, secretBox, clientForApp: () => client, feeLedger, clock: () => new Date(time) });
  return { dataDir, opened, apps, service, client, feeLedger, feeOrder, get payment() { return payment; }, set payment(v) { payment = v; }, get approvalCalls() { return approvalCalls; }, get completionCalls() { return completionCalls; }, advance(ms) { time = new Date(time.getTime() + ms); } };
}

test("Pi approval binds platform-verified user, app payment, amount, memo, metadata, and direction", async () => {
  const ctx = setup();
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    const approved = await ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) });
    assert.equal(approved.status, "approved");
    assert.equal(approved.verification_state, "unverified");
    assert.equal(ctx.approvalCalls, 1);
    const stored = ctx.opened.db.prepare("SELECT server_key_ciphertext FROM pi_app_configs WHERE application_id='pi-workflow'").get();
    assert.equal(stored.server_key_ciphertext.includes("pi-server-secret"), false);
    assert.equal(ctx.opened.db.prepare("SELECT pi_user_uid FROM payment_transactions WHERE session_id='PS-1'").get().pi_user_uid, "pi_user_1");
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("Pi payment rejects tampered or cross-user data before approval and remains retryable", async () => {
  const ctx = setup();
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    ctx.payment = makePayment({ amount: 3 });
    await assert.rejects(ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) }), { code: "PI_PAYMENT_MISMATCH" });
    assert.equal(ctx.approvalCalls, 0);
    assert.equal(ctx.opened.db.prepare("SELECT count(*) AS n FROM payment_transactions").get().n, 0);
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("Pi completion requires authoritative verified txid, is idempotent, and rejects conflicting txids", async () => {
  const ctx = setup();
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    await ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) });
    const txid = "a".repeat(64);
    ctx.payment = { ...ctx.payment, transaction: { txid, verified: true }, status: { ...ctx.payment.status, transaction_verified: true } };
    const complete = await ctx.service.complete({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid });
    assert.equal(complete.status, "completed"); assert.equal(complete.verification_state, "verified");
    assert.equal(ctx.completionCalls, 1);
    assert.equal((await ctx.service.complete({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid })).status, "completed");
    await assert.rejects(ctx.service.complete({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid: "b".repeat(64) }), { code: "PI_PAYMENT_CONFLICT" });
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("Pi reconciliation recovers an interrupted completion only after authoritative Platform confirmation", async () => {
  const ctx = setup();
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    await ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) });
    const txid = "c".repeat(64);
    ctx.payment = { ...ctx.payment, transaction: { txid, verified: true }, status: { ...ctx.payment.status, transaction_verified: true } };
    ctx.client.completePayment = async () => { throw Object.assign(new Error("socket closed"), { code: "PI_PLATFORM_UNAVAILABLE" }); };
    await assert.rejects(ctx.service.complete({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid }), { code: "PI_PLATFORM_UNAVAILABLE" });
    const pending = ctx.opened.db.prepare("SELECT status,verification_state FROM payment_transactions WHERE session_id='PS-1'").get();
    assert.equal(pending.status, "completion_pending"); assert.equal(pending.verification_state, "verified");
    ctx.payment = { ...ctx.payment, status: { ...ctx.payment.status, developer_approved: true, transaction_verified: true, developer_completed: true } };
    ctx.advance(31_000);
    const results = await ctx.service.reconcile();
    assert.deepEqual(results, [{ session_id: "PS-1", status: "completed" }]);
    assert.equal(ctx.opened.db.prepare("SELECT status FROM payment_sessions WHERE session_id='PS-1'").get().status, "completed");
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("Pi recovery reconciles its linked fee order after lost completion response", async () => {
  const ctx = setup({ linkedFeeOrder: true });
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    await ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) });
    const txid = "d".repeat(64);
    ctx.payment = { ...ctx.payment, transaction: { txid, verified: true }, status: { ...ctx.payment.status, transaction_verified: true } };
    ctx.client.completePayment = async () => { throw Object.assign(new Error("response lost"), { code: "PI_PLATFORM_UNAVAILABLE" }); };
    await assert.rejects(ctx.service.complete({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid }), { code: "PI_PLATFORM_UNAVAILABLE" });
    assert.equal(ctx.feeLedger.canDeliver({ applicationId: "pi-workflow", orderId: ctx.feeOrder.order_id }), false);
    ctx.payment = { ...ctx.payment, status: { ...ctx.payment.status, developer_approved: true, transaction_verified: true, developer_completed: true } };
    ctx.advance(31_000);
    const results = await ctx.service.reconcile();
    assert.equal(results.some((result) => result.fee_order_status === "paid"), true);
    assert.equal(ctx.feeLedger.canDeliver({ applicationId: "pi-workflow", orderId: ctx.feeOrder.order_id }), true);
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("Pi cancellation reconciles a linked fee order as failed without enabling delivery", async () => {
  const ctx = setup({ linkedFeeOrder: true });
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    ctx.client.approvePayment = async () => { throw Object.assign(new Error("response lost"), { code: "PI_PLATFORM_UNAVAILABLE" }); };
    await assert.rejects(ctx.service.approve({ applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) }), { code: "PI_PLATFORM_UNAVAILABLE" });
    ctx.payment = { ...ctx.payment, status: { ...ctx.payment.status, cancelled: true } };
    ctx.advance(31_000);
    const results = await ctx.service.reconcile();
    assert.equal(results[0].status, "failed");
    assert.equal(ctx.feeLedger.getOrder({ applicationId: "pi-workflow", orderId: ctx.feeOrder.order_id }).status, "failed");
    assert.equal(ctx.feeLedger.canDeliver({ applicationId: "pi-workflow", orderId: ctx.feeOrder.order_id }), false);
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test("concurrent Pi callbacks claim approval and completion once", async () => {
  const ctx = setup();
  try {
    ctx.service.configure({ applicationId: "pi-workflow", piAppId: "pi-app-test", serverApiKey: "pi-server-secret", network: "testnet" });
    let approvals = 0, completions = 0;
    ctx.client.approvePayment = async () => { approvals += 1; await new Promise((resolve) => setTimeout(resolve, 30)); ctx.payment = { ...ctx.payment, status: { ...ctx.payment.status, developer_approved: true } }; return ctx.payment; };
    const approvalArgs = { applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", userAccessToken: "u".repeat(40) };
    const approvalsResult = await Promise.all([ctx.service.approve(approvalArgs), ctx.service.approve(approvalArgs)]);
    assert.equal(approvals, 1); assert.ok(approvalsResult.some((result) => result.status === "approving"));
    const txid = "d".repeat(64);
    ctx.payment = { ...ctx.payment, transaction: { txid, verified: true }, status: { ...ctx.payment.status, transaction_verified: true } };
    ctx.client.completePayment = async (_id, exactTxid) => { completions += 1; await new Promise((resolve) => setTimeout(resolve, 30)); ctx.payment = { ...ctx.payment, status: { ...ctx.payment.status, developer_completed: true }, transaction: { txid: exactTxid, verified: true } }; return ctx.payment; };
    const completionArgs = { applicationId: "pi-workflow", sessionId: "PS-1", paymentId: "pi_payment_01", txid };
    const completionResults = await Promise.all([ctx.service.complete(completionArgs), ctx.service.complete(completionArgs)]);
    assert.equal(completions, 1); assert.ok(completionResults.every((result) => ["completed", "completion_pending"].includes(result.status)));
    ctx.advance(31_000);
    await ctx.service.reconcile();
    assert.equal(ctx.opened.db.prepare("SELECT status FROM payment_transactions WHERE session_id='PS-1'").get().status, "completed");
  } finally { ctx.opened.close(); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});
