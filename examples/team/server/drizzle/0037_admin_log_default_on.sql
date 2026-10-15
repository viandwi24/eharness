-- The admin log of a chat the account administers is collected by default. Rows that carry
-- `enabled: false` without an owner's choice (`explicit`) are the old default: forget the value
-- (no value = on). A switch the owner turned off since this change carries `explicit: true`.
UPDATE `ch_node_access`
SET `extra` = json_remove(`extra`, '$.adminLog.enabled')
WHERE `member` IN ('admin', 'owner')
  AND json_valid(`extra`)
  AND json_extract(`extra`, '$.adminLog.enabled') = 0
  AND COALESCE(json_extract(`extra`, '$.adminLog.explicit'), 0) = 0;
