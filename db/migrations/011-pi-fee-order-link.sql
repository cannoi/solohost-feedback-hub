ALTER TABLE payment_sessions ADD COLUMN fee_order_id TEXT REFERENCES fee_orders(order_id);
CREATE UNIQUE INDEX payment_sessions_fee_order_idx ON payment_sessions(fee_order_id) WHERE fee_order_id IS NOT NULL;
