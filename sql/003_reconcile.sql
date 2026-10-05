-- Run read-only as an operations role with authorized private-schema SELECT.
-- A healthy installation returns ZERO rows. Use this after restores and daily.
-- No direct balance editing: investigate any returned drift before repair.
WITH assets AS (
  SELECT u.tenant_id,v.token_type,'User'::text AS bucket,u.id AS account_id,v.actual
  FROM race_private.users u CROSS JOIN LATERAL
    (VALUES ('GC'::race_private.token_type,u.gc_balance),('SC'::race_private.token_type,u.sc_balance)) v(token_type,actual)
  UNION ALL
  SELECT tenant_id,token_type,'Escrow',id,remaining_escrow FROM race_private.challenges
  UNION ALL
  SELECT tenant_id,token_type,'Treasury',tenant_id,balance FROM race_private.treasury
), projection AS (
  SELECT j.tenant_id,j.token_type,l.bucket::text AS bucket,
    CASE WHEN l.bucket='User' THEN l.user_id WHEN l.bucket='Escrow' THEN j.challenge_id ELSE j.tenant_id END AS account_id,
    sum(l.delta) AS expected
  FROM race_private.journal_transactions j JOIN race_private.journal_lines l
    ON (l.tenant_id,l.transaction_id)=(j.tenant_id,j.id)
  WHERE l.bucket<>'Issuance'
  GROUP BY j.tenant_id,j.token_type,l.bucket,
    CASE WHEN l.bucket='User' THEN l.user_id WHEN l.bucket='Escrow' THEN j.challenge_id ELSE j.tenant_id END
)
SELECT coalesce(a.tenant_id,p.tenant_id) AS tenant_id,
  coalesce(a.token_type,p.token_type) AS token_type,
  coalesce(a.bucket,p.bucket) AS bucket,coalesce(a.account_id,p.account_id) AS account_id,
  coalesce(a.actual,0) AS actual,coalesce(p.expected,0) AS expected,
  coalesce(a.actual,0)-coalesce(p.expected,0) AS drift
FROM assets a FULL OUTER JOIN projection p
  ON (a.tenant_id,a.token_type,a.bucket,a.account_id)=(p.tenant_id,p.token_type,p.bucket,p.account_id)
WHERE coalesce(a.actual,0)<>coalesce(p.expected,0);
