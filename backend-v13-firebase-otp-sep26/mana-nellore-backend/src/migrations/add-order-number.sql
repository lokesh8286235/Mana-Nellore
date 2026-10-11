-- Migration: add order_number to orders (idempotent — safe to re-run).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_number_key') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);
  END IF;
END $$;
