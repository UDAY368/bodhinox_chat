SET LOCAL lock_timeout = '5s';

-- Store plan Phase 3, package 2: abandoned-cart reminder and COD confirmation. Additive.
-- commerce_settings.abandoned_cart_delay_minutes: NULL = off, else 30..2880 minutes after a shop
--   session first gets items. commerce_settings.cod_confirm_enabled: ask COD customers to confirm.
--   Both are written by admins only (column grant; the tenant_write policy needs the admin role).
-- storefront_sessions.reminded_at / reminder_skip: set by the worker once the one reminder was
--   sent, or why it was not (a code, never customer content).
-- orders.cod_confirmation: the customer's answer to the COD confirmation message. Written only by
--   the worker (inbound reply, order placement); staff read it. It is not one of the columns the
--   priced-order freeze trigger guards, so it may change after pricing.
-- order_notice_templates and order_messages: the two new notice kinds. The CHECKs are rebuilt as a
--   superset of 20261108100500_courier_shipping.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261128001000_shop_cart_cod_followups.

ALTER TABLE commerce_settings ADD COLUMN abandoned_cart_delay_minutes integer;
ALTER TABLE commerce_settings ADD COLUMN cod_confirm_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commerce_settings ADD CONSTRAINT commerce_settings_abandoned_delay_check
  CHECK (abandoned_cart_delay_minutes IS NULL OR abandoned_cart_delay_minutes BETWEEN 30 AND 2880) NOT VALID;
ALTER TABLE commerce_settings VALIDATE CONSTRAINT commerce_settings_abandoned_delay_check;
GRANT UPDATE (abandoned_cart_delay_minutes, cod_confirm_enabled) ON commerce_settings TO bodhinox_app;

ALTER TABLE storefront_sessions ADD COLUMN reminded_at timestamptz;
ALTER TABLE storefront_sessions ADD COLUMN reminder_skip text;
ALTER TABLE storefront_sessions ADD CONSTRAINT storefront_sessions_reminder_skip_check
  CHECK (reminder_skip IS NULL OR reminder_skip ~ '^[a-z0-9_]{1,64}$') NOT VALID;
ALTER TABLE storefront_sessions VALIDATE CONSTRAINT storefront_sessions_reminder_skip_check;

ALTER TABLE orders ADD COLUMN cod_confirmation text;
ALTER TABLE orders ADD CONSTRAINT orders_cod_confirmation_check
  CHECK (cod_confirmation IS NULL OR (cod_confirmation IN ('pending','confirmed','declined') AND payment_method = 'cod')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_cod_confirmation_check;
-- The two CHECKs are replaced by supersets; the new ones are NOT VALID, then validated (every existing row passes).
ALTER TABLE order_notice_templates DROP CONSTRAINT order_notice_templates_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_notice_templates ADD CONSTRAINT order_notice_templates_kind_check
  CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase','abandoned_cart','cod_confirm')) NOT VALID;
ALTER TABLE order_notice_templates VALIDATE CONSTRAINT order_notice_templates_kind_check;

ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('checkout_link','payment_link','receipt',
  'dispatched','delivered','feedback','product_follow_up','repeat_purchase','cod_confirm')) NOT VALID;
ALTER TABLE order_messages VALIDATE CONSTRAINT order_messages_kind_check;
