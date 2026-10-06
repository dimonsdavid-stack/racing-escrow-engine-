-- FRESH INSTALL ONLY. Existing installations apply only unapplied migrations.
-- Each migration is atomic; RPC calls are single PostgREST transactions.

-- Source: sql/001_engine.sql
-- Fresh-install schema. Apply as the database migration owner (postgres).
-- All objects below are created in ONE transaction. Runtime RPC calls each run
-- in a separate PostgREST transaction; functions never issue COMMIT internally.
BEGIN;
CREATE SCHEMA race_private;
REVOKE ALL ON SCHEMA race_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA race_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA race_private REVOKE ALL ON TABLES FROM PUBLIC;

CREATE TYPE race_private.token_type AS ENUM ('GC', 'SC');
CREATE TYPE race_private.challenge_status AS ENUM ('Pending', 'Active', 'Settled', 'Disputed');
CREATE TYPE race_private.resolution AS ENUM ('winner', 'no_clean_laps', 'network_drop', 'tie', 'timeout');
CREATE TYPE race_private.bucket AS ENUM ('User', 'Escrow', 'Treasury', 'Issuance');

CREATE TABLE race_private.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sc_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE race_private.providers (
  tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),
  id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE race_private.users (
  tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),
  id uuid NOT NULL,
  -- Bind to an authenticated identity during provisioning; not supplied by a browser.
  auth_user_id uuid NOT NULL,
  gc_balance numeric(24,6) NOT NULL DEFAULT 0,
  sc_balance numeric(24,6) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, auth_user_id),
  CHECK (gc_balance >= 0 AND gc_balance < 'Infinity'::numeric),
  CHECK (sc_balance >= 0 AND sc_balance < 'Infinity'::numeric)
);
CREATE TABLE race_private.challenges (
  tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),
  id uuid NOT NULL,
  challenger_id uuid NOT NULL,
  opponent_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  session_id uuid NOT NULL,
  token_type race_private.token_type NOT NULL,
  entry_fee numeric(24,6) NOT NULL,
  -- Immutable original gross pool; remaining_escrow is the current liability.
  total_escrow_pool numeric(24,6) NOT NULL,
  remaining_escrow numeric(24,6) NOT NULL,
  platform_rake numeric(24,6) NOT NULL,
  rake_charged numeric(24,6) NOT NULL DEFAULT 0,
  status race_private.challenge_status NOT NULL DEFAULT 'Pending',
  winner_id uuid,
  resolution race_private.resolution,
  challenger_best numeric(18,6),
  opponent_best numeric(18,6),
  telemetry_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_id, session_id),
  FOREIGN KEY (tenant_id, challenger_id) REFERENCES race_private.users(tenant_id, id),
  FOREIGN KEY (tenant_id, opponent_id) REFERENCES race_private.users(tenant_id, id),
  FOREIGN KEY (tenant_id, winner_id) REFERENCES race_private.users(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES race_private.providers(tenant_id, id),
  CHECK (challenger_id <> opponent_id),
  CHECK (entry_fee > 0 AND entry_fee < 'Infinity'::numeric AND entry_fee = trunc(entry_fee, 2)),
  CHECK (total_escrow_pool = entry_fee * 2),
  CHECK (platform_rake = total_escrow_pool * 0.10),
  CHECK (remaining_escrow IN (0, total_escrow_pool)),
  CHECK (rake_charged >= 0 AND rake_charged <= platform_rake),
  CHECK (winner_id IS NULL OR winner_id IN (challenger_id, opponent_id)),
  CHECK (challenger_best IS NULL OR (challenger_best > 0 AND challenger_best < 'Infinity'::numeric)),
  CHECK (opponent_best IS NULL OR (opponent_best > 0 AND opponent_best < 'Infinity'::numeric)),
  CHECK (
    (status <> 'Settled' AND remaining_escrow = total_escrow_pool AND
      resolution IS NULL AND winner_id IS NULL AND settled_at IS NULL AND rake_charged = 0)
    OR
    (status = 'Settled' AND remaining_escrow = 0 AND resolution IS NOT NULL AND settled_at IS NOT NULL AND
      ((resolution = 'winner' AND winner_id IS NOT NULL AND rake_charged = platform_rake)
       OR (resolution <> 'winner' AND winner_id IS NULL AND rake_charged = 0)))
  )
);
CREATE INDEX challenges_timeout_idx ON race_private.challenges (telemetry_deadline, tenant_id, id)
  WHERE status = 'Active';
CREATE INDEX challenges_challenger_idx ON race_private.challenges(tenant_id, challenger_id);
CREATE INDEX challenges_opponent_idx ON race_private.challenges(tenant_id, opponent_id);
CREATE TABLE race_private.treasury (
  tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),
  token_type race_private.token_type NOT NULL,
  balance numeric(24,6) NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance < 'Infinity'::numeric),
  PRIMARY KEY (tenant_id, token_type)
);
CREATE TABLE race_private.journal_transactions (
  tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  challenge_id uuid,
  token_type race_private.token_type NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fund', 'settle', 'refund', 'grant')),
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, external_ref),
  FOREIGN KEY (tenant_id, challenge_id) REFERENCES race_private.challenges(tenant_id, id),
  CHECK ((kind = 'grant' AND challenge_id IS NULL AND external_ref IS NOT NULL)
      OR (kind <> 'grant' AND challenge_id IS NOT NULL AND external_ref IS NULL))
);
CREATE UNIQUE INDEX journal_funding_once ON race_private.journal_transactions(tenant_id, challenge_id)
  WHERE kind = 'fund';
CREATE UNIQUE INDEX journal_completion_once ON race_private.journal_transactions(tenant_id, challenge_id)
  WHERE kind IN ('settle', 'refund');
CREATE TABLE race_private.journal_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  bucket race_private.bucket NOT NULL,
  user_id uuid,
  delta numeric(24,6) NOT NULL CHECK (delta <> 0 AND abs(delta) < 'Infinity'::numeric),
  FOREIGN KEY (tenant_id, transaction_id) REFERENCES race_private.journal_transactions(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES race_private.users(tenant_id, id),
  CHECK ((bucket = 'User' AND user_id IS NOT NULL) OR (bucket <> 'User' AND user_id IS NULL))
);
CREATE INDEX journal_lines_tx_idx ON race_private.journal_lines(tenant_id, transaction_id);
CREATE INDEX journal_lines_user_idx ON race_private.journal_lines(tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE TABLE race_private.telemetry_events (
  tenant_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  event_id text NOT NULL,
  challenge_id uuid NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_id, event_id),
  UNIQUE (tenant_id, challenge_id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES race_private.providers(tenant_id, id),
  FOREIGN KEY (tenant_id, challenge_id) REFERENCES race_private.challenges(tenant_id, id)
);

-- Defense in depth: no client or service-role DML privileges on private tables.
ALTER TABLE race_private.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.treasury ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.journal_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.telemetry_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION race_private.immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'append_only_record' USING ERRCODE = 'PT409'; END;
$$;
CREATE TRIGGER immutable_journal_transactions BEFORE UPDATE OR DELETE ON race_private.journal_transactions
  FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();
CREATE TRIGGER immutable_journal_lines BEFORE UPDATE OR DELETE ON race_private.journal_lines
  FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();
CREATE TRIGGER immutable_telemetry_events BEFORE UPDATE OR DELETE ON race_private.telemetry_events
  FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();

CREATE FUNCTION race_private.check_balanced_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_tx uuid; v_sum numeric; v_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'journal_transactions' THEN v_tx := NEW.id; ELSE v_tx := NEW.transaction_id; END IF;
  SELECT coalesce(sum(delta), 0), count(*) INTO v_sum, v_count
    FROM race_private.journal_lines WHERE tenant_id = NEW.tenant_id AND transaction_id = v_tx;
  IF v_sum <> 0 OR v_count < 2 THEN
    RAISE EXCEPTION 'unbalanced_journal' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_transaction AFTER INSERT ON race_private.journal_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION race_private.check_balanced_journal();
CREATE CONSTRAINT TRIGGER balanced_lines AFTER INSERT ON race_private.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION race_private.check_balanced_journal();

-- Backend-only primitives. SECURITY DEFINER is intentionally confined to the
-- unexposed schema; explicit EXECUTE allowlists appear at the end of this file.
CREATE FUNCTION race_private.create_and_lock_challenge(
  p_tenant_id uuid, p_request_id uuid, p_challenger_id uuid, p_opponent_id uuid,
  p_token_type text, p_entry_fee numeric, p_provider_id uuid, p_session_id uuid,
  p_telemetry_deadline timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '3s' SET statement_timeout = '10s' AS $$
DECLARE c race_private.challenges%ROWTYPE; v_count integer; v_tx uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_request_id IS NULL OR p_challenger_id IS NULL OR p_opponent_id IS NULL
    OR p_provider_id IS NULL OR p_session_id IS NULL OR p_telemetry_deadline IS NULL
    OR p_challenger_id = p_opponent_id OR p_token_type IS NULL OR p_token_type NOT IN ('GC','SC')
    OR p_entry_fee IS NULL OR NOT (p_entry_fee > 0 AND p_entry_fee <= 1000000)
    OR p_entry_fee <> trunc(p_entry_fee, 2) THEN
    RAISE EXCEPTION 'invalid_challenge' USING ERRCODE = 'PT400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('challenge:' || p_tenant_id::text || p_request_id::text, 0));
  SELECT * INTO c FROM race_private.challenges
    WHERE tenant_id = p_tenant_id AND id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF (c.challenger_id, c.opponent_id, c.token_type::text, c.entry_fee, c.provider_id, c.session_id, c.telemetry_deadline)
      IS DISTINCT FROM (p_challenger_id, p_opponent_id, p_token_type, p_entry_fee, p_provider_id, p_session_id, p_telemetry_deadline) THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('challenge_id', c.id, 'status', c.status, 'duplicate', true,
      'pool', c.total_escrow_pool::text, 'rake', c.platform_rake::text);
  END IF;
  IF p_telemetry_deadline <= clock_timestamp() OR p_telemetry_deadline > clock_timestamp() + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid_deadline' USING ERRCODE = 'PT400';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM race_private.tenants WHERE id = p_tenant_id AND enabled
    AND (p_token_type = 'GC' OR sc_enabled)) THEN
    RAISE EXCEPTION 'tenant_or_currency_disabled' USING ERRCODE = 'PT403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM race_private.providers WHERE tenant_id = p_tenant_id AND id = p_provider_id AND enabled) THEN
    RAISE EXCEPTION 'provider_unavailable' USING ERRCODE = 'PT403';
  END IF;
  -- Canonical lock order prevents AB/BA deadlocks. NO KEY UPDATE also remains
  -- compatible with FK KEY SHARE locks; balance updates do not change keys.
  PERFORM id FROM race_private.users WHERE tenant_id = p_tenant_id
    AND id IN (p_challenger_id, p_opponent_id) ORDER BY id FOR NO KEY UPDATE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN RAISE EXCEPTION 'unknown_participants' USING ERRCODE = 'PT404'; END IF;
  IF EXISTS (SELECT 1 FROM race_private.users WHERE tenant_id = p_tenant_id AND id IN (p_challenger_id,p_opponent_id)
    AND (NOT enabled OR CASE WHEN p_token_type = 'GC' THEN gc_balance ELSE sc_balance END < p_entry_fee)) THEN
    RAISE EXCEPTION 'insufficient_funds_or_disabled' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO race_private.challenges(tenant_id,id,challenger_id,opponent_id,provider_id,session_id,
    token_type,entry_fee,total_escrow_pool,remaining_escrow,platform_rake,status,telemetry_deadline)
  VALUES (p_tenant_id,p_request_id,p_challenger_id,p_opponent_id,p_provider_id,p_session_id,
    p_token_type::race_private.token_type,p_entry_fee,p_entry_fee*2,p_entry_fee*2,p_entry_fee*2*0.10,'Active',p_telemetry_deadline)
  RETURNING * INTO c;
  UPDATE race_private.users SET
    gc_balance = gc_balance - CASE WHEN p_token_type = 'GC' THEN p_entry_fee ELSE 0 END,
    sc_balance = sc_balance - CASE WHEN p_token_type = 'SC' THEN p_entry_fee ELSE 0 END
    WHERE tenant_id = p_tenant_id AND id IN (p_challenger_id,p_opponent_id);
  INSERT INTO race_private.journal_transactions(tenant_id,challenge_id,token_type,kind)
    VALUES (p_tenant_id,c.id,c.token_type,'fund') RETURNING id INTO v_tx;
  INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES
    (p_tenant_id,v_tx,'User',p_challenger_id,-p_entry_fee),
    (p_tenant_id,v_tx,'User',p_opponent_id,-p_entry_fee),
    (p_tenant_id,v_tx,'Escrow',NULL,p_entry_fee*2);
  RETURN jsonb_build_object('challenge_id',c.id,'status',c.status,'duplicate',false,
    'pool',c.total_escrow_pool::text,'rake',c.platform_rake::text);
END;
$$;

-- Shared posting primitive. No application role may call it directly.
CREATE FUNCTION race_private.finish_challenge(
  p_tenant_id uuid, p_challenge_id uuid, p_provider_id uuid, p_event_id text,
  p_sha256 text, p_resolution race_private.resolution, p_winner_id uuid,
  p_challenger_best numeric, p_opponent_best numeric, p_timeout boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE c race_private.challenges%ROWTYPE; e race_private.telemetry_events%ROWTYPE;
  v_tx uuid; v_result jsonb; v_rake numeric; v_payout numeric;
BEGIN
  SELECT * INTO c FROM race_private.challenges WHERE tenant_id = p_tenant_id AND id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR c.provider_id <> p_provider_id THEN
    RAISE EXCEPTION 'challenge_not_found' USING ERRCODE = 'PT404';
  END IF;
  SELECT * INTO e FROM race_private.telemetry_events
    WHERE tenant_id = p_tenant_id AND provider_id = p_provider_id AND event_id = p_event_id;
  IF FOUND THEN
    IF e.challenge_id <> c.id OR e.payload_sha256 <> p_sha256 THEN
      RAISE EXCEPTION 'event_idempotency_conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN e.result || jsonb_build_object('duplicate',true);
  END IF;
  IF c.status <> 'Active' THEN RAISE EXCEPTION 'challenge_not_active' USING ERRCODE = 'PT409'; END IF;
  -- The timestamp in a signed payload cannot extend this deadline.
  IF p_timeout AND clock_timestamp() < c.telemetry_deadline THEN
    RAISE EXCEPTION 'timeout_not_due' USING ERRCODE = 'PT409';
  ELSIF NOT p_timeout AND clock_timestamp() >= c.telemetry_deadline THEN
    RAISE EXCEPTION 'telemetry_deadline_passed' USING ERRCODE = 'PT409';
  END IF;
  IF (p_resolution = 'winner' AND (p_winner_id IS NULL OR p_winner_id NOT IN (c.challenger_id,c.opponent_id)))
    OR (p_resolution <> 'winner' AND p_winner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_winner' USING ERRCODE = 'PT400';
  END IF;
  PERFORM id FROM race_private.users WHERE tenant_id = p_tenant_id
    AND id IN (c.challenger_id,c.opponent_id) ORDER BY id FOR NO KEY UPDATE;
  v_rake := CASE WHEN p_resolution = 'winner' THEN c.platform_rake ELSE 0 END;
  v_payout := CASE WHEN p_resolution = 'winner' THEN c.total_escrow_pool-v_rake ELSE 0 END;
  IF p_resolution = 'winner' THEN
    UPDATE race_private.users SET
      gc_balance = gc_balance + CASE WHEN c.token_type = 'GC' THEN v_payout ELSE 0 END,
      sc_balance = sc_balance + CASE WHEN c.token_type = 'SC' THEN v_payout ELSE 0 END
      WHERE tenant_id = p_tenant_id AND id = p_winner_id;
    INSERT INTO race_private.treasury(tenant_id,token_type,balance) VALUES(p_tenant_id,c.token_type,v_rake)
      ON CONFLICT(tenant_id,token_type) DO UPDATE SET balance = race_private.treasury.balance+EXCLUDED.balance;
  ELSE
    UPDATE race_private.users SET
      gc_balance = gc_balance + CASE WHEN c.token_type = 'GC' THEN c.entry_fee ELSE 0 END,
      sc_balance = sc_balance + CASE WHEN c.token_type = 'SC' THEN c.entry_fee ELSE 0 END
      WHERE tenant_id = p_tenant_id AND id IN (c.challenger_id,c.opponent_id);
  END IF;
  UPDATE race_private.challenges SET status='Settled',remaining_escrow=0,winner_id=p_winner_id,
    resolution=p_resolution,rake_charged=v_rake,settled_at=clock_timestamp(),
    challenger_best=p_challenger_best,opponent_best=p_opponent_best
    WHERE tenant_id = p_tenant_id AND id = c.id;
  INSERT INTO race_private.journal_transactions(tenant_id,challenge_id,token_type,kind)
    VALUES(p_tenant_id,c.id,c.token_type,CASE WHEN p_resolution='winner' THEN 'settle' ELSE 'refund' END)
    RETURNING id INTO v_tx;
  INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,delta)
    VALUES(p_tenant_id,v_tx,'Escrow',-c.total_escrow_pool);
  IF p_resolution = 'winner' THEN
    INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES
      (p_tenant_id,v_tx,'User',p_winner_id,v_payout), (p_tenant_id,v_tx,'Treasury',NULL,v_rake);
  ELSE
    INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES
      (p_tenant_id,v_tx,'User',c.challenger_id,c.entry_fee),(p_tenant_id,v_tx,'User',c.opponent_id,c.entry_fee);
  END IF;
  v_result := jsonb_build_object('challenge_id',c.id,'status','Settled','resolution',p_resolution,
    'winner_id',p_winner_id,'rake_charged',v_rake::text,'winner_payout',v_payout::text,
    'refund_per_user',CASE WHEN p_resolution='winner' THEN '0' ELSE c.entry_fee::text END,
    'remaining_escrow','0','duplicate',false);
  INSERT INTO race_private.telemetry_events(tenant_id,provider_id,event_id,challenge_id,payload_sha256,result)
    VALUES(p_tenant_id,p_provider_id,p_event_id,c.id,p_sha256,v_result);
  RETURN v_result;
END;
$$;

CREATE FUNCTION race_private.settle_challenge(
  p_tenant_id uuid, p_provider_id uuid, p_challenge_id uuid, p_session_id uuid,
  p_event_id uuid, p_payload_sha256 text, p_challenger_id uuid, p_opponent_id uuid,
  p_resolution text, p_winner_id uuid, p_challenger_best numeric, p_opponent_best numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '3s' SET statement_timeout = '10s' AS $$
DECLARE c race_private.challenges%ROWTYPE; v_expected uuid; v_resolution text;
BEGIN
  IF p_event_id IS NULL OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    OR p_resolution IS NULL OR p_resolution NOT IN ('winner','tie','no_clean_laps','network_drop') THEN
    RAISE EXCEPTION 'invalid_event' USING ERRCODE='PT400';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM race_private.providers WHERE tenant_id=p_tenant_id AND id=p_provider_id AND enabled) THEN
    RAISE EXCEPTION 'provider_unavailable' USING ERRCODE='PT403';
  END IF;
  SELECT * INTO c FROM race_private.challenges WHERE tenant_id=p_tenant_id AND id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR (c.provider_id,c.session_id,c.challenger_id,c.opponent_id)
      IS DISTINCT FROM (p_provider_id,p_session_id,p_challenger_id,p_opponent_id) THEN
    RAISE EXCEPTION 'challenge_binding_mismatch' USING ERRCODE='PT404';
  END IF;
  IF (p_challenger_best IS NOT NULL AND NOT (p_challenger_best>0 AND p_challenger_best<=86400 AND p_challenger_best=trunc(p_challenger_best,6)))
    OR (p_opponent_best IS NOT NULL AND NOT (p_opponent_best>0 AND p_opponent_best<=86400 AND p_opponent_best=trunc(p_opponent_best,6))) THEN
    RAISE EXCEPTION 'invalid_lap_summary' USING ERRCODE='PT400';
  END IF;
  IF p_resolution = 'network_drop' THEN
    v_resolution := 'network_drop';
  ELSIF p_challenger_best IS NULL AND p_opponent_best IS NULL THEN
    v_resolution := 'no_clean_laps';
  ELSIF p_challenger_best = p_opponent_best THEN v_resolution := 'tie';
  ELSE
    v_resolution := 'winner';
    v_expected := CASE WHEN p_opponent_best IS NULL OR
      (p_challenger_best IS NOT NULL AND p_challenger_best<p_opponent_best)
      THEN c.challenger_id ELSE c.opponent_id END;
  END IF;
  IF p_resolution<>v_resolution OR p_winner_id IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'decision_mismatch' USING ERRCODE='PT400';
  END IF;
  RETURN race_private.finish_challenge(p_tenant_id,c.id,p_provider_id,p_event_id::text,
    p_payload_sha256,p_resolution::race_private.resolution,p_winner_id,p_challenger_best,p_opponent_best);
END;
$$;

CREATE FUNCTION race_private.refund_expired_challenge(p_tenant_id uuid,p_challenge_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE c race_private.challenges%ROWTYPE;
BEGIN
  SELECT * INTO c FROM race_private.challenges WHERE tenant_id=p_tenant_id AND id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'challenge_not_found' USING ERRCODE='PT404'; END IF;
  IF c.status='Settled' THEN RETURN jsonb_build_object('challenge_id',c.id,'status',c.status,'duplicate',true); END IF;
  RETURN race_private.finish_challenge(p_tenant_id,c.id,c.provider_id,'timeout:'||c.id::text,
    repeat(md5('timeout:'||p_tenant_id::text||c.id::text),2),'timeout',NULL,NULL,NULL,true);
END;
$$;
CREATE FUNCTION race_private.list_expired_challenges(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('tenant_id',tenant_id,'challenge_id',id)), '[]'::jsonb)
  FROM (SELECT tenant_id,id FROM race_private.challenges
    WHERE status='Active' AND telemetry_deadline<=clock_timestamp()
    ORDER BY telemetry_deadline,tenant_id,id LIMIT greatest(1,least(coalesce(p_limit,100),500))) q;
$$;

-- Idempotent grants establish auditable opening balances/promotional issuance.
-- GC/SC remain separate. This is not a purchase, cash redemption, or conversion API.
CREATE FUNCTION race_private.credit_wallet(p_tenant_id uuid,p_user_id uuid,p_token_type text,
  p_amount numeric,p_external_ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE v_tx uuid; j race_private.journal_transactions%ROWTYPE;
BEGIN
  IF p_external_ref IS NULL OR length(p_external_ref) NOT BETWEEN 1 AND 200 OR p_token_type IS NULL
    OR p_token_type NOT IN ('GC','SC') OR p_amount IS NULL OR NOT(p_amount>0 AND p_amount<=1000000)
    OR p_amount<>trunc(p_amount,6) THEN RAISE EXCEPTION 'invalid_grant' USING ERRCODE='PT400'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('grant:'||p_tenant_id::text||p_external_ref,0));
  SELECT * INTO j FROM race_private.journal_transactions WHERE tenant_id=p_tenant_id AND external_ref=p_external_ref;
  IF FOUND THEN
    IF j.token_type::text<>p_token_type OR NOT EXISTS(SELECT 1 FROM race_private.journal_lines
      WHERE tenant_id=p_tenant_id AND transaction_id=j.id AND user_id=p_user_id AND delta=p_amount) THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('transaction_id',j.id,'duplicate',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled
    AND(p_token_type='GC' OR sc_enabled)) THEN RAISE EXCEPTION 'tenant_or_currency_disabled' USING ERRCODE='PT403'; END IF;
  PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=p_user_id AND enabled FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_user' USING ERRCODE='PT404'; END IF;
  UPDATE race_private.users SET gc_balance=gc_balance+CASE WHEN p_token_type='GC' THEN p_amount ELSE 0 END,
    sc_balance=sc_balance+CASE WHEN p_token_type='SC' THEN p_amount ELSE 0 END WHERE tenant_id=p_tenant_id AND id=p_user_id;
  INSERT INTO race_private.journal_transactions(tenant_id,token_type,kind,external_ref)
    VALUES(p_tenant_id,p_token_type::race_private.token_type,'grant',p_external_ref) RETURNING id INTO v_tx;
  INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES
    (p_tenant_id,v_tx,'User',p_user_id,p_amount),(p_tenant_id,v_tx,'Issuance',NULL,-p_amount);
  RETURN jsonb_build_object('transaction_id',v_tx,'duplicate',false);
END;
$$;

-- Exposed invoker wrappers carry no elevated privilege themselves.
CREATE FUNCTION public.create_and_lock_challenge(p_tenant_id uuid,p_request_id uuid,p_challenger_id uuid,
  p_opponent_id uuid,p_token_type text,p_entry_fee numeric,p_provider_id uuid,p_session_id uuid,p_telemetry_deadline timestamptz)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog SET statement_timeout='10s' AS $$
  SELECT race_private.create_and_lock_challenge(p_tenant_id,p_request_id,p_challenger_id,p_opponent_id,
    p_token_type,p_entry_fee,p_provider_id,p_session_id,p_telemetry_deadline);
$$;
CREATE FUNCTION public.settle_challenge(p_tenant_id uuid,p_provider_id uuid,p_challenge_id uuid,p_session_id uuid,
  p_event_id uuid,p_payload_sha256 text,p_challenger_id uuid,p_opponent_id uuid,p_resolution text,
  p_winner_id uuid,p_challenger_best numeric,p_opponent_best numeric)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog SET statement_timeout='10s' AS $$
  SELECT race_private.settle_challenge(p_tenant_id,p_provider_id,p_challenge_id,p_session_id,p_event_id,
    p_payload_sha256,p_challenger_id,p_opponent_id,p_resolution,p_winner_id,p_challenger_best,p_opponent_best);
$$;
CREATE FUNCTION public.refund_expired_challenge(p_tenant_id uuid,p_challenge_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog SET statement_timeout='10s' AS $$
  SELECT race_private.refund_expired_challenge(p_tenant_id,p_challenge_id);
$$;
CREATE FUNCTION public.list_expired_challenges(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog SET statement_timeout='10s' AS $$
  SELECT race_private.list_expired_challenges(p_limit);
$$;
CREATE FUNCTION public.credit_wallet(p_tenant_id uuid,p_user_id uuid,p_token_type text,p_amount numeric,p_external_ref text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog SET statement_timeout='10s' AS $$
  SELECT race_private.credit_wallet(p_tenant_id,p_user_id,p_token_type,p_amount,p_external_ref);
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA race_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA race_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA race_private FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA race_private TO service_role;
-- Apply only to these functions: do not alter unrelated public schema privileges.
DO $$ DECLARE f record; BEGIN
  -- Match exact signatures, not names: an unrelated public overload must not
  -- have its permissions changed by this installation.
  FOR f IN SELECT signature FROM (VALUES
    ('public.create_and_lock_challenge(uuid,uuid,uuid,uuid,text,numeric,uuid,uuid,timestamptz)'::regprocedure),
    ('race_private.create_and_lock_challenge(uuid,uuid,uuid,uuid,text,numeric,uuid,uuid,timestamptz)'::regprocedure),
    ('public.settle_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid,numeric,numeric)'::regprocedure),
    ('race_private.settle_challenge(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid,numeric,numeric)'::regprocedure),
    ('public.refund_expired_challenge(uuid,uuid)'::regprocedure),
    ('race_private.refund_expired_challenge(uuid,uuid)'::regprocedure),
    ('public.list_expired_challenges(integer)'::regprocedure),
    ('race_private.list_expired_challenges(integer)'::regprocedure),
    ('public.credit_wallet(uuid,uuid,text,numeric,text)'::regprocedure),
    ('race_private.credit_wallet(uuid,uuid,text,numeric,text)'::regprocedure)
  ) AS allowed(signature)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END; $$;
NOTIFY pgrst, 'reload schema';
COMMIT;


-- Source: supabase/migrations/20261005224115_customer_app.sql
-- Apply after sql/001_engine.sql. Authenticated customer RPCs never accept actor IDs.
BEGIN;
ALTER TABLE race_private.tenants ADD COLUMN customer_signup_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE race_private.profiles (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,handle text NOT NULL,
 terms_version text NOT NULL DEFAULT 'social-v1',terms_accepted_at timestamptz NOT NULL DEFAULT now(),
 sc_eligible boolean NOT NULL DEFAULT false,pause_until timestamptz,
 PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),
 CHECK(handle ~ '^[A-Za-z0-9_]{3,20}$')
);
CREATE UNIQUE INDEX profile_handle_unique ON race_private.profiles(tenant_id,lower(handle));
CREATE TABLE race_private.tracks (
 tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),id text NOT NULL,title text NOT NULL,
 provider_id uuid,enabled boolean NOT NULL DEFAULT false,session_minutes integer NOT NULL DEFAULT 15,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),
 CHECK(id IN('coastal','club','night')),CHECK(session_minutes BETWEEN 5 AND 60),CHECK(NOT enabled OR provider_id IS NOT NULL)
);
CREATE TABLE race_private.offers (
 tenant_id uuid NOT NULL,id uuid NOT NULL,creator_id uuid NOT NULL,track_id text NOT NULL,
 token_type race_private.token_type NOT NULL,entry_fee numeric(24,6) NOT NULL,provider_id uuid NOT NULL,session_minutes integer NOT NULL,
 state text NOT NULL DEFAULT 'Open',expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),accepted_by uuid,session_id uuid,deadline timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,creator_id) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,accepted_by) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,track_id) REFERENCES race_private.tracks(tenant_id,id),
 FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),CHECK(session_minutes BETWEEN 5 AND 60),
 CHECK(state IN('Open','Accepted','Cancelled')),CHECK(entry_fee>0 AND entry_fee<=1000 AND entry_fee=trunc(entry_fee,2)),
 CHECK((state='Accepted')=(accepted_by IS NOT NULL AND session_id IS NOT NULL AND deadline IS NOT NULL)),
 CHECK(accepted_by IS NULL OR accepted_by<>creator_id)
);
CREATE INDEX offers_lobby ON race_private.offers(tenant_id,created_at DESC) WHERE state='Open';
ALTER TABLE race_private.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE race_private.offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON race_private.profiles,race_private.tracks,race_private.offers FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION race_private.customer_identity() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid(); claims jsonb; sid uuid;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=actor AND email_confirmed_at IS NOT NULL
  AND coalesce(is_anonymous,false)=false AND (banned_until IS NULL OR banned_until<now())) THEN
  RAISE EXCEPTION 'verified_account_required' USING ERRCODE='PT403';
 END IF;
 claims:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}');
 BEGIN sid:=(claims->>'session_id')::uuid; EXCEPTION WHEN invalid_text_representation THEN sid:=NULL; END;
 IF sid IS NULL OR NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=sid AND user_id=actor) THEN
  RAISE EXCEPTION 'active_session_required' USING ERRCODE='PT403';
 END IF;
 RETURN actor;
END; $$;
CREATE FUNCTION race_private.customer_wallet(p_tenant_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=race_private.customer_identity(); wallet uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled AND customer_signup_enabled) THEN
  RAISE EXCEPTION 'tenant_unavailable' USING ERRCODE='PT403'; END IF;
 SELECT id INTO wallet FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=actor AND enabled;
 IF wallet IS NULL THEN RAISE EXCEPTION 'profile_required' USING ERRCODE='PT409'; END IF;
 RETURN wallet;
END; $$;
CREATE FUNCTION race_private.customer_can_play(p_tenant_id uuid,p_wallet uuid,p_currency text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=p_tenant_id AND user_id=p_wallet
  AND (pause_until IS NULL OR pause_until<=now()) AND(p_currency='GC' OR(p_currency='SC' AND sc_eligible))) OR
  NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled AND(p_currency='GC' OR sc_enabled)) THEN
  RAISE EXCEPTION 'play_or_currency_unavailable' USING ERRCODE='PT403'; END IF;
END; $$;
CREATE FUNCTION race_private.customer_enroll(p_tenant_id uuid,p_handle text,p_accept_terms boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE actor uuid:=race_private.customer_identity(); wallet uuid; old_handle text;
BEGIN
 IF p_accept_terms IS DISTINCT FROM true OR p_handle IS NULL OR p_handle !~ '^[A-Za-z0-9_]{3,20}$' THEN
  RAISE EXCEPTION 'invalid_profile_or_terms' USING ERRCODE='PT400'; END IF;
 IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled AND customer_signup_enabled) THEN
  RAISE EXCEPTION 'tenant_unavailable' USING ERRCODE='PT403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('enroll:'||p_tenant_id::text||actor::text,0));
 SELECT id INTO wallet FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=actor AND enabled;
 IF wallet IS NOT NULL THEN
  SELECT handle INTO old_handle FROM race_private.profiles WHERE tenant_id=p_tenant_id AND user_id=wallet;
  IF old_handle IS DISTINCT FROM p_handle THEN RAISE EXCEPTION 'profile_already_exists' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('user_id',wallet,'handle',old_handle,'duplicate',true);
 END IF;
 wallet:=gen_random_uuid();
 INSERT INTO race_private.users(tenant_id,id,auth_user_id) VALUES(p_tenant_id,wallet,actor);
 INSERT INTO race_private.profiles(tenant_id,user_id,handle) VALUES(p_tenant_id,wallet,p_handle);
 PERFORM race_private.credit_wallet(p_tenant_id,wallet,'GC',1000,'welcome:'||actor::text);
 RETURN jsonb_build_object('user_id',wallet,'handle',p_handle,'duplicate',false);
END; $$;
CREATE FUNCTION race_private.customer_state(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id); result jsonb;
BEGIN
 SELECT jsonb_build_object('user_id',u.id,'handle',p.handle,'gc_balance',u.gc_balance::text,
 'sc_balance',u.sc_balance::text,'sc_eligible',p.sc_eligible AND t.sc_enabled,'pause_until',p.pause_until,
 'gc_locked_entry',coalesce((SELECT sum(entry_fee) FROM race_private.challenges WHERE tenant_id=p_tenant_id AND token_type='GC' AND remaining_escrow>0 AND wallet IN(challenger_id,opponent_id)),0)::numeric(24,6)::text,
 'sc_locked_entry',coalesce((SELECT sum(entry_fee) FROM race_private.challenges WHERE tenant_id=p_tenant_id AND token_type='SC' AND remaining_escrow>0 AND wallet IN(challenger_id,opponent_id)),0)::numeric(24,6)::text,
 'history',coalesce((SELECT jsonb_agg(row_to_json(h)) FROM(SELECT j.id,j.kind,j.token_type,l.delta::text,j.created_at,j.challenge_id
  FROM race_private.journal_lines l JOIN race_private.journal_transactions j ON j.tenant_id=l.tenant_id AND j.id=l.transaction_id
  WHERE l.tenant_id=p_tenant_id AND l.user_id=wallet ORDER BY j.created_at DESC,j.id LIMIT 50) h),'[]'::jsonb),
 'races',coalesce((SELECT jsonb_agg(row_to_json(r)) FROM(SELECT c.id,c.status,c.token_type,c.entry_fee::text,
 c.total_escrow_pool::text,c.platform_rake::text,c.remaining_escrow::text,c.rake_charged::text,c.winner_id,c.resolution,
 c.challenger_best::text,c.opponent_best::text,c.telemetry_deadline,c.session_id,c.created_at,c.settled_at,
 o.track_id,op.handle AS opponent FROM race_private.challenges c
 LEFT JOIN race_private.offers o ON o.tenant_id=c.tenant_id AND o.id=c.id
 LEFT JOIN race_private.profiles op ON op.tenant_id=c.tenant_id AND op.user_id=CASE WHEN c.challenger_id=wallet THEN c.opponent_id ELSE c.challenger_id END
 WHERE c.tenant_id=p_tenant_id AND wallet IN(c.challenger_id,c.opponent_id) ORDER BY c.created_at DESC LIMIT 50) r),'[]'::jsonb)) INTO result
 FROM race_private.users u JOIN race_private.profiles p ON p.tenant_id=u.tenant_id AND p.user_id=u.id
 JOIN race_private.tenants t ON t.id=u.tenant_id WHERE u.tenant_id=p_tenant_id AND u.id=wallet;
 RETURN result;
END; $$;
CREATE FUNCTION race_private.customer_lobby(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id);
BEGIN
 RETURN jsonb_build_object('tracks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'title',title,'enabled',enabled,'session_minutes',session_minutes))
 FROM race_private.tracks WHERE tenant_id=p_tenant_id),'[]'::jsonb),'offers',coalesce((SELECT jsonb_agg(row_to_json(o)) FROM
 (SELECT f.id,f.track_id,f.token_type,f.entry_fee::text,f.session_minutes,p.handle,f.expires_at,f.creator_id=wallet AS mine FROM race_private.offers f
 JOIN race_private.profiles p ON p.tenant_id=f.tenant_id AND p.user_id=f.creator_id
 WHERE f.tenant_id=p_tenant_id AND f.state='Open' AND f.expires_at>now() ORDER BY f.created_at DESC LIMIT 50) o),'[]'::jsonb));
END; $$;
CREATE FUNCTION race_private.customer_offer(p_tenant_id uuid,p_request_id uuid,p_track_id text,p_token_type text,p_entry_fee text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id); fee numeric; existing race_private.offers%ROWTYPE; track race_private.tracks%ROWTYPE;
BEGIN
 IF p_request_id IS NULL OR p_entry_fee IS NULL OR p_entry_fee !~ '^[0-9]{1,4}(\.[0-9]{1,2})?$'
  OR p_token_type IS NULL OR p_token_type NOT IN('GC','SC') THEN RAISE EXCEPTION 'invalid_offer' USING ERRCODE='PT400'; END IF;
 fee:=p_entry_fee::numeric;
 IF fee<=0 OR fee>1000 THEN RAISE EXCEPTION 'invalid_fee' USING ERRCODE='PT400'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('offer:'||p_tenant_id::text||p_request_id::text,0));
 SELECT * INTO existing FROM race_private.offers WHERE tenant_id=p_tenant_id AND id=p_request_id;
 IF FOUND THEN
  IF(existing.creator_id,existing.track_id,existing.token_type::text,existing.entry_fee) IS DISTINCT FROM(wallet,p_track_id,p_token_type,fee)
   THEN RAISE EXCEPTION 'offer_idempotency_conflict' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('offer_id',existing.id,'state',existing.state,'duplicate',true);
 END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=wallet FOR NO KEY UPDATE;
 PERFORM race_private.customer_can_play(p_tenant_id,wallet,p_token_type);
 SELECT t.* INTO track FROM race_private.tracks t JOIN race_private.providers p ON p.tenant_id=t.tenant_id AND p.id=t.provider_id
  WHERE t.tenant_id=p_tenant_id AND t.id=p_track_id AND t.enabled AND p.enabled;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'race_provider_not_connected' USING ERRCODE='PT409'; END IF;
 IF NOT EXISTS(SELECT 1 FROM race_private.users WHERE tenant_id=p_tenant_id AND id=wallet
  AND CASE WHEN p_token_type='GC' THEN gc_balance ELSE sc_balance END>=fee) THEN
  RAISE EXCEPTION 'insufficient_balance' USING ERRCODE='PT409'; END IF;
 IF(SELECT count(*) FROM race_private.offers WHERE tenant_id=p_tenant_id AND creator_id=wallet AND state='Open' AND expires_at>now())>=10 THEN
  RAISE EXCEPTION 'open_offer_limit' USING ERRCODE='PT409'; END IF;
 INSERT INTO race_private.offers(tenant_id,id,creator_id,track_id,token_type,entry_fee,provider_id,session_minutes)
 VALUES(p_tenant_id,p_request_id,wallet,p_track_id,p_token_type::race_private.token_type,fee,track.provider_id,track.session_minutes);
 RETURN jsonb_build_object('offer_id',p_request_id,'state','Open','duplicate',false);
END; $$;
CREATE FUNCTION race_private.customer_accept(p_tenant_id uuid,p_offer_id uuid,p_accept_terms boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id); o race_private.offers%ROWTYPE;
 track race_private.tracks%ROWTYPE; result jsonb; new_session uuid; new_deadline timestamptz;
BEGIN
 IF p_accept_terms IS DISTINCT FROM true THEN RAISE EXCEPTION 'acceptance_required' USING ERRCODE='PT400'; END IF;
 SELECT * INTO o FROM race_private.offers WHERE tenant_id=p_tenant_id AND id=p_offer_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found' USING ERRCODE='PT404'; END IF;
 IF o.state='Accepted' AND o.accepted_by=wallet THEN RETURN jsonb_build_object('challenge_id',o.id,'session_id',o.session_id,'deadline',o.deadline,'duplicate',true); END IF;
 IF o.creator_id=wallet OR o.state<>'Open' OR o.expires_at<=now() THEN RAISE EXCEPTION 'offer_unavailable' USING ERRCODE='PT409'; END IF;
 -- Lock both participants before checking pause/eligibility, in the same order as funding.
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id IN(wallet,o.creator_id) ORDER BY id FOR NO KEY UPDATE;
 PERFORM race_private.customer_can_play(p_tenant_id,wallet,o.token_type::text);
 PERFORM race_private.customer_can_play(p_tenant_id,o.creator_id,o.token_type::text);
 SELECT * INTO track FROM race_private.tracks WHERE tenant_id=p_tenant_id AND id=o.track_id AND enabled;
 IF NOT FOUND OR (track.provider_id,track.session_minutes) IS DISTINCT FROM (o.provider_id,o.session_minutes) THEN
 RAISE EXCEPTION 'race_provider_or_terms_changed' USING ERRCODE='PT409'; END IF;
 new_session:=gen_random_uuid(); new_deadline:=now()+make_interval(mins=>o.session_minutes);
 result:=race_private.create_and_lock_challenge(p_tenant_id,o.id,o.creator_id,wallet,o.token_type::text,o.entry_fee,o.provider_id,new_session,new_deadline);
 UPDATE race_private.offers SET state='Accepted',accepted_by=wallet,session_id=new_session,deadline=new_deadline WHERE tenant_id=p_tenant_id AND id=o.id;
 RETURN result||jsonb_build_object('session_id',new_session,'deadline',new_deadline);
END; $$;
CREATE FUNCTION race_private.customer_cancel(p_tenant_id uuid,p_offer_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id); o race_private.offers%ROWTYPE;
BEGIN
 SELECT * INTO o FROM race_private.offers WHERE tenant_id=p_tenant_id AND id=p_offer_id FOR UPDATE;
 IF NOT FOUND OR o.creator_id<>wallet THEN RAISE EXCEPTION 'offer_not_found' USING ERRCODE='PT404'; END IF;
 IF o.state='Accepted' THEN RAISE EXCEPTION 'funded_race_cannot_cancel' USING ERRCODE='PT409'; END IF;
 UPDATE race_private.offers SET state='Cancelled' WHERE tenant_id=p_tenant_id AND id=p_offer_id;
 RETURN jsonb_build_object('offer_id',p_offer_id,'state','Cancelled');
END; $$;
CREATE FUNCTION race_private.customer_daily(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id);
BEGIN
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=wallet FOR NO KEY UPDATE;
 PERFORM race_private.customer_can_play(p_tenant_id,wallet,'GC');
 RETURN race_private.credit_wallet(p_tenant_id,wallet,'GC',100,'daily:'||wallet::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'));
END; $$;
CREATE FUNCTION race_private.customer_pause(p_tenant_id uuid,p_hours integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wallet uuid:=race_private.customer_wallet(p_tenant_id); until_time timestamptz;
BEGIN
 IF p_hours IS NULL OR p_hours NOT IN(1,24,168) THEN RAISE EXCEPTION 'invalid_pause' USING ERRCODE='PT400'; END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=wallet FOR NO KEY UPDATE;
 UPDATE race_private.profiles SET pause_until=greatest(coalesce(pause_until,now()),now()+make_interval(hours=>p_hours))
 WHERE tenant_id=p_tenant_id AND user_id=wallet RETURNING pause_until INTO until_time;
 RETURN jsonb_build_object('pause_until',until_time);
END; $$;
-- Explicit invoker wrappers; only private customer implementations elevate privileges.
CREATE FUNCTION public.race_enroll(p_tenant_id uuid,p_handle text,p_accept_terms boolean) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_enroll(p_tenant_id,p_handle,p_accept_terms)$$;
CREATE FUNCTION public.race_state(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_state(p_tenant_id)$$;
CREATE FUNCTION public.race_lobby(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_lobby(p_tenant_id)$$;
CREATE FUNCTION public.race_offer(p_tenant_id uuid,p_request_id uuid,p_track_id text,p_token_type text,p_entry_fee text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_offer(p_tenant_id,p_request_id,p_track_id,p_token_type,p_entry_fee)$$;
CREATE FUNCTION public.race_accept(p_tenant_id uuid,p_offer_id uuid,p_accept_terms boolean) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_accept(p_tenant_id,p_offer_id,p_accept_terms)$$;
CREATE FUNCTION public.race_cancel(p_tenant_id uuid,p_offer_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_cancel(p_tenant_id,p_offer_id)$$;
CREATE FUNCTION public.race_daily(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_daily(p_tenant_id)$$;
CREATE FUNCTION public.race_pause(p_tenant_id uuid,p_hours integer) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.customer_pause(p_tenant_id,p_hours)$$;
GRANT USAGE ON SCHEMA race_private TO authenticated;
DO $$ DECLARE f regprocedure; BEGIN
 FOREACH f IN ARRAY ARRAY[
 'public.race_enroll(uuid,text,boolean)'::regprocedure,'public.race_state(uuid)'::regprocedure,'public.race_lobby(uuid)'::regprocedure,
 'public.race_offer(uuid,uuid,text,text,text)'::regprocedure,'public.race_accept(uuid,uuid,boolean)'::regprocedure,'public.race_cancel(uuid,uuid)'::regprocedure,
 'public.race_daily(uuid)'::regprocedure,'public.race_pause(uuid,integer)'::regprocedure,
 'race_private.customer_enroll(uuid,text,boolean)'::regprocedure,'race_private.customer_state(uuid)'::regprocedure,'race_private.customer_lobby(uuid)'::regprocedure,
 'race_private.customer_offer(uuid,uuid,text,text,text)'::regprocedure,'race_private.customer_accept(uuid,uuid,boolean)'::regprocedure,'race_private.customer_cancel(uuid,uuid)'::regprocedure,
 'race_private.customer_daily(uuid)'::regprocedure,'race_private.customer_pause(uuid,integer)'::regprocedure]
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f); END LOOP;
END; $$;
REVOKE ALL ON FUNCTION race_private.customer_identity(),race_private.customer_wallet(uuid),race_private.customer_can_play(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;


-- Source: supabase/migrations/20261006073056_sim_racing_commerce.sql
-- Incremental migration: external simulators, explicit consent, commerce receipts.
-- Apply after 001_engine.sql and 20261005224115_customer_app.sql, as postgres.
BEGIN;
ALTER TABLE race_private.profiles ADD COLUMN payment_review boolean NOT NULL DEFAULT false;
ALTER TABLE race_private.tenants ADD COLUMN commerce_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE race_private.tenants ADD COLUMN program_terms_url text;
CREATE TABLE race_private.driver_identities (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN('iracing','acc','discord')),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 80),verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,provider),UNIQUE(tenant_id,provider,external_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.sim_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL,provider_id uuid NOT NULL,game text NOT NULL CHECK(game IN('iracing','acc')),
 external_session_id text NOT NULL CHECK(length(external_session_id) BETWEEN 1 AND 100),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),track_name text NOT NULL CHECK(length(track_name) BETWEEN 1 AND 120),
 starts_at timestamptz NOT NULL,funding_closes_at timestamptz NOT NULL,deadline timestamptz NOT NULL,
 rule text NOT NULL CHECK(rule IN('fastest_clean_lap','finish_position')),
 entrants jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(entrants)='array' AND jsonb_array_length(entrants)<=200),
 state text NOT NULL DEFAULT 'Scheduled' CHECK(state IN('Scheduled','Completed','Cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,provider_id,external_session_id),FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),
 CHECK(funding_closes_at<=starts_at AND starts_at<deadline AND deadline<=starts_at+interval '23 hours')
);
CREATE INDEX sim_events_upcoming ON race_private.sim_events(tenant_id,starts_at) WHERE state='Scheduled';
CREATE TABLE race_private.sim_offers (
 tenant_id uuid NOT NULL,id uuid NOT NULL,event_id uuid NOT NULL,creator_id uuid NOT NULL,target_id uuid,
 mode text NOT NULL CHECK(mode IN('driver_duel','event_match')),selection_a text NOT NULL,selection_b text,
 token_type race_private.token_type NOT NULL,entry_fee numeric(24,6) NOT NULL CHECK(entry_fee>0 AND entry_fee<=1000 AND entry_fee=trunc(entry_fee,2)),
 state text NOT NULL DEFAULT 'Open' CHECK(state IN('Open','Accepted','Cancelled')),accepted_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz,terms_version text NOT NULL DEFAULT 'sim-v3',
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,event_id) REFERENCES race_private.sim_events(tenant_id,id),
 FOREIGN KEY(tenant_id,creator_id) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,target_id) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,accepted_by) REFERENCES race_private.users(tenant_id,id),
 CHECK(target_id IS NULL OR target_id<>creator_id),CHECK(accepted_by IS NULL OR accepted_by<>creator_id),
 CHECK((state='Accepted')=(accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
 CHECK(selection_b IS NULL OR selection_b<>selection_a)
);
CREATE INDEX sim_offers_open ON race_private.sim_offers(tenant_id,created_at DESC) WHERE state='Open';
CREATE TABLE race_private.sim_contracts (
 tenant_id uuid NOT NULL,challenge_id uuid NOT NULL,event_id uuid NOT NULL,
 selection_a text NOT NULL,selection_b text NOT NULL,rule text NOT NULL,game text NOT NULL,
 funded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,challenge_id),FOREIGN KEY(tenant_id,challenge_id) REFERENCES race_private.challenges(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES race_private.sim_events(tenant_id,id),CHECK(selection_a<>selection_b)
);
CREATE TABLE race_private.provider_evidence (
 tenant_id uuid NOT NULL,challenge_id uuid NOT NULL,source_id text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 summary jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,challenge_id),
 FOREIGN KEY(tenant_id,challenge_id) REFERENCES race_private.sim_contracts(tenant_id,challenge_id)
);
CREATE TABLE race_private.result_jobs (
 tenant_id uuid NOT NULL,challenge_id uuid NOT NULL,state text NOT NULL DEFAULT 'Queued' CHECK(state IN('Queued','Leased','Done')),
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,challenge_id),FOREIGN KEY(tenant_id,challenge_id) REFERENCES race_private.sim_contracts(tenant_id,challenge_id)
);
CREATE INDEX result_jobs_due ON race_private.result_jobs(available_at) WHERE state<>'Done';
CREATE TABLE race_private.oauth_states (
 state_hash text PRIMARY KEY CHECK(state_hash~'^[0-9a-f]{64}$'),tenant_id uuid NOT NULL,user_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN('iracing','steam')),verifier_cipher text NOT NULL,expires_at timestamptz NOT NULL,
 consumed_at timestamptz,FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.oauth_tokens (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,provider text NOT NULL CHECK(provider='iracing'),cipher text NOT NULL,
 expires_at timestamptz NOT NULL,version integer NOT NULL DEFAULT 1,refresh_lease uuid,refresh_started_at timestamptz,
 PRIMARY KEY(tenant_id,user_id,provider),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.commerce_catalog (
 tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),id text NOT NULL,amount_cents integer NOT NULL CHECK(amount_cents>0),
 gc numeric(24,6) NOT NULL CHECK(gc>0),sc numeric(24,6) NOT NULL DEFAULT 0 CHECK(sc>=0),enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE race_private.commerce_orders (
 tenant_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,package_id text NOT NULL,
 amount_cents integer NOT NULL,currency text NOT NULL DEFAULT 'usd' CHECK(currency='usd'),gc numeric(24,6) NOT NULL,sc numeric(24,6) NOT NULL,
 state text NOT NULL DEFAULT 'Created' CHECK(state IN('Created','Paid','Review','Failed')),stripe_session_id text,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(stripe_session_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,package_id) REFERENCES race_private.commerce_catalog(tenant_id,id)
);
CREATE TABLE race_private.payment_ledgers (
 stripe_payment_intent text PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,amount_cents integer NOT NULL CHECK(amount_cents>0),
 stripe_event_id text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES race_private.commerce_orders(tenant_id,id)
);
CREATE TABLE race_private.payment_cases (
 stripe_event_id text PRIMARY KEY,stripe_payment_intent text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'Review' CHECK(status IN('Review','Resolved'))
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['driver_identities','sim_events','sim_offers','sim_contracts','provider_evidence','result_jobs','oauth_states','oauth_tokens','commerce_catalog','commerce_orders','payment_ledgers','payment_cases'] LOOP
 EXECUTE format('ALTER TABLE race_private.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON race_private.%I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP; END $$;
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON race_private.provider_evidence FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON race_private.payment_ledgers FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();
CREATE TRIGGER contracts_immutable BEFORE UPDATE OR DELETE ON race_private.sim_contracts FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record();

CREATE FUNCTION race_private.sim_offer_internal(t uuid,actor uuid,request uuid,event uuid,mode text,currency text,fee text,selection text,target uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e race_private.sim_events%ROWTYPE;o race_private.sim_offers%ROWTYPE;chosen text; f numeric;
BEGIN
 IF request IS NULL OR mode IS NULL OR mode NOT IN('driver_duel','event_match') OR currency IS NULL OR currency NOT IN('GC','SC') OR fee IS NULL OR fee!~'^\d{1,4}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'invalid_offer' USING ERRCODE='PT400'; END IF;
 f:=fee::numeric;IF f<=0 OR f>1000 OR target=actor THEN RAISE EXCEPTION 'invalid_offer' USING ERRCODE='PT400'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sim-offer:'||t::text||request::text,0));
 SELECT * INTO o FROM race_private.sim_offers WHERE tenant_id=t AND id=request FOR UPDATE;
 SELECT * INTO e FROM race_private.sim_events WHERE tenant_id=t AND id=event FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found' USING ERRCODE='PT404'; END IF;
 IF mode='driver_duel' THEN SELECT external_id INTO chosen FROM race_private.driver_identities WHERE tenant_id=t AND user_id=actor AND provider=e.game;
 ELSE chosen:=selection; END IF;
 IF chosen IS NULL OR length(chosen)>80 THEN RAISE EXCEPTION 'verified_driver_required' USING ERRCODE='PT403'; END IF;
 IF o.id IS NOT NULL THEN
 IF (o.creator_id,o.event_id,o.mode,o.token_type::text,o.entry_fee,o.selection_a,o.target_id) IS DISTINCT FROM(actor,event,mode,currency,f,chosen,target) THEN RAISE EXCEPTION 'offer_idempotency_conflict' USING ERRCODE='PT409'; END IF;
 RETURN jsonb_build_object('offer_id',o.id,'state',o.state,'duplicate',true); END IF;
 IF e.state<>'Scheduled' OR clock_timestamp()>=e.funding_closes_at OR e.deadline>clock_timestamp()+interval '24 hours' THEN RAISE EXCEPTION 'funding_closed' USING ERRCODE='PT409'; END IF;
 IF NOT(e.entrants ? chosen) THEN RAISE EXCEPTION 'driver_not_registered' USING ERRCODE='PT403'; END IF;
 IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM race_private.users WHERE tenant_id=t AND id=target AND enabled) THEN RAISE EXCEPTION 'opponent_not_found' USING ERRCODE='PT404'; END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=actor FOR NO KEY UPDATE;
 PERFORM race_private.customer_can_play(t,actor,currency);
 IF EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=t AND user_id=actor AND payment_review) THEN RAISE EXCEPTION 'account_review' USING ERRCODE='PT403'; END IF;
 INSERT INTO race_private.sim_offers(tenant_id,id,event_id,creator_id,target_id,mode,selection_a,token_type,entry_fee) VALUES(t,request,event,actor,target,mode,chosen,currency::race_private.token_type,f);
 RETURN jsonb_build_object('offer_id',request,'state','Open','duplicate',false);
END $$;
CREATE FUNCTION race_private.sim_accept_internal(t uuid,actor uuid,offer uuid,terms boolean,selection text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o race_private.sim_offers%ROWTYPE;e race_private.sim_events%ROWTYPE;chosen text;original text;r jsonb;
BEGIN
 IF terms IS DISTINCT FROM true THEN RAISE EXCEPTION 'acceptance_required' USING ERRCODE='PT400'; END IF;
 SELECT * INTO o FROM race_private.sim_offers WHERE tenant_id=t AND id=offer FOR UPDATE;
 IF NOT FOUND OR o.creator_id=actor OR(o.target_id IS NOT NULL AND o.target_id<>actor) THEN RAISE EXCEPTION 'offer_unavailable' USING ERRCODE='PT403'; END IF;
 IF o.state='Accepted' AND o.accepted_by=actor THEN
 IF o.mode='event_match' AND o.selection_b IS DISTINCT FROM selection THEN RAISE EXCEPTION 'selection_conflict' USING ERRCODE='PT409'; END IF;
 RETURN (SELECT jsonb_build_object('challenge_id',c.id,'status',c.status,'duplicate',true,'pool',c.total_escrow_pool::text,'rake',c.platform_rake::text) FROM race_private.challenges c WHERE c.tenant_id=t AND c.id=o.id); END IF;
 SELECT * INTO e FROM race_private.sim_events WHERE tenant_id=t AND id=o.event_id FOR SHARE;
 IF o.state<>'Open' OR e.state<>'Scheduled' OR clock_timestamp()>=e.funding_closes_at THEN RAISE EXCEPTION 'funding_closed' USING ERRCODE='PT409'; END IF;
 -- All account/profile/identity changes also acquire this canonical wallet lock.
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id IN(actor,o.creator_id) ORDER BY id FOR NO KEY UPDATE;
 PERFORM race_private.customer_can_play(t,actor,o.token_type::text);PERFORM race_private.customer_can_play(t,o.creator_id,o.token_type::text);
 IF EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=t AND user_id IN(actor,o.creator_id) AND payment_review) THEN RAISE EXCEPTION 'account_review' USING ERRCODE='PT403'; END IF;
 IF o.mode='driver_duel' THEN
 SELECT external_id INTO chosen FROM race_private.driver_identities WHERE tenant_id=t AND user_id=actor AND provider=e.game;
 SELECT external_id INTO original FROM race_private.driver_identities WHERE tenant_id=t AND user_id=o.creator_id AND provider=e.game;
 IF original IS DISTINCT FROM o.selection_a THEN RAISE EXCEPTION 'driver_binding_changed' USING ERRCODE='PT409'; END IF;
 ELSE chosen:=selection; END IF;
 IF chosen IS NULL OR chosen=o.selection_a OR NOT(e.entrants ? chosen) THEN RAISE EXCEPTION 'distinct_registered_driver_required' USING ERRCODE='PT403'; END IF;
 r:=race_private.create_and_lock_challenge(t,o.id,o.creator_id,actor,o.token_type::text,o.entry_fee,e.provider_id,gen_random_uuid(),e.deadline);
 INSERT INTO race_private.sim_contracts(tenant_id,challenge_id,event_id,selection_a,selection_b,rule,game) VALUES(t,o.id,e.id,o.selection_a,chosen,e.rule,e.game);
 UPDATE race_private.sim_offers SET state='Accepted',accepted_by=actor,selection_b=chosen,accepted_at=clock_timestamp() WHERE tenant_id=t AND id=o.id;
 INSERT INTO race_private.result_jobs(tenant_id,challenge_id,available_at) VALUES(t,o.id,e.starts_at+interval '5 minutes');
 RETURN r;
END $$;
CREATE FUNCTION public.sim_offer(p_tenant_id uuid,p_request_id uuid,p_event_id uuid,p_mode text,p_token_type text,p_entry_fee text,p_selection text DEFAULT NULL,p_target_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$SELECT race_private.sim_offer_internal(p_tenant_id,race_private.customer_wallet(p_tenant_id),p_request_id,p_event_id,p_mode,p_token_type,p_entry_fee,p_selection,p_target_id)$$;
CREATE FUNCTION public.sim_accept(p_tenant_id uuid,p_offer_id uuid,p_accept_terms boolean,p_selection text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$SELECT race_private.sim_accept_internal(p_tenant_id,race_private.customer_wallet(p_tenant_id),p_offer_id,p_accept_terms,p_selection)$$;
CREATE FUNCTION public.sim_cancel(p_tenant_id uuid,p_offer_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);o race_private.sim_offers%ROWTYPE;
BEGIN SELECT * INTO o FROM race_private.sim_offers WHERE tenant_id=p_tenant_id AND id=p_offer_id FOR UPDATE;
 IF NOT FOUND OR o.creator_id<>a OR o.state='Accepted' THEN RAISE EXCEPTION 'offer_unavailable' USING ERRCODE='PT403'; END IF;
 UPDATE race_private.sim_offers SET state='Cancelled' WHERE tenant_id=p_tenant_id AND id=p_offer_id;
 RETURN jsonb_build_object('offer_id',p_offer_id,'state','Cancelled'); END $$;
CREATE FUNCTION public.sim_lobby(p_tenant_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);
BEGIN RETURN jsonb_build_object('events',coalesce((SELECT jsonb_agg(row_to_json(e)) FROM(SELECT id,game,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants FROM race_private.sim_events WHERE tenant_id=p_tenant_id AND state='Scheduled' AND deadline>now() ORDER BY starts_at LIMIT 100)e),'[]'::jsonb),
 'offers',coalesce((SELECT jsonb_agg(row_to_json(o)) FROM(SELECT f.id,f.event_id,f.mode,f.token_type,f.entry_fee::text,f.selection_a,f.target_id,f.creator_id=a AS mine,p.handle,e.title,e.track_name,e.game,e.rule,e.funding_closes_at FROM race_private.sim_offers f JOIN race_private.sim_events e ON e.tenant_id=f.tenant_id AND e.id=f.event_id JOIN race_private.profiles p ON p.tenant_id=f.tenant_id AND p.user_id=f.creator_id WHERE f.tenant_id=p_tenant_id AND f.state='Open' AND e.state='Scheduled' AND e.funding_closes_at>now() AND(f.target_id IS NULL OR a IN(f.target_id,f.creator_id)) ORDER BY f.created_at DESC LIMIT 100)o),'[]'::jsonb)); END $$;
CREATE FUNCTION public.sim_state(p_tenant_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);r jsonb;
BEGIN r:=race_private.customer_state(p_tenant_id);
 RETURN r||jsonb_build_object('payment_review',(SELECT payment_review FROM race_private.profiles WHERE tenant_id=p_tenant_id AND user_id=a),'identities',coalesce((SELECT jsonb_agg(jsonb_build_object('provider',provider,'external_id',external_id,'verified_at',verified_at)) FROM race_private.driver_identities WHERE tenant_id=p_tenant_id AND user_id=a),'[]'::jsonb),
 'contracts',coalesce((SELECT jsonb_agg(row_to_json(k)) FROM(SELECT s.challenge_id AS id,s.event_id,s.selection_a,s.selection_b,s.rule,s.game,e.title,e.track_name,c.status,c.resolution,c.entry_fee::text,c.total_escrow_pool::text,c.platform_rake::text,c.winner_id,c.challenger_best::text,c.opponent_best::text,c.telemetry_deadline,v.summary AS evidence FROM race_private.sim_contracts s JOIN race_private.challenges c ON c.tenant_id=s.tenant_id AND c.id=s.challenge_id JOIN race_private.sim_events e ON e.tenant_id=s.tenant_id AND e.id=s.event_id LEFT JOIN race_private.provider_evidence v ON v.tenant_id=s.tenant_id AND v.challenge_id=s.challenge_id WHERE s.tenant_id=p_tenant_id AND a IN(c.challenger_id,c.opponent_id) ORDER BY c.created_at DESC LIMIT 100)k),'[]'::jsonb)); END $$;
CREATE FUNCTION public.sim_request_result(p_tenant_id uuid,p_challenge_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);
BEGIN IF NOT EXISTS(SELECT 1 FROM race_private.challenges c JOIN race_private.sim_contracts s ON s.tenant_id=c.tenant_id AND s.challenge_id=c.id WHERE c.tenant_id=p_tenant_id AND c.id=p_challenge_id AND a IN(c.challenger_id,c.opponent_id)) THEN RAISE EXCEPTION 'challenge_not_found' USING ERRCODE='PT404'; END IF;
 UPDATE race_private.result_jobs SET available_at=least(available_at,now()) WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id AND state='Queued';
 RETURN jsonb_build_object('status','Queued'); END $$;

-- Service boundaries: callers derive auth_user_id from getUser, never request JSON.
CREATE FUNCTION public.sim_link_identity(p_tenant_id uuid,p_auth_user_id uuid,p_provider text,p_external_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE a uuid;
BEGIN SELECT id INTO a FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=p_auth_user_id AND enabled FOR NO KEY UPDATE;
 IF NOT FOUND OR p_provider NOT IN('iracing','acc','discord') OR p_external_id IS NULL OR length(p_external_id) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'invalid_identity' USING ERRCODE='PT400'; END IF;
 IF EXISTS(SELECT 1 FROM race_private.challenges WHERE tenant_id=p_tenant_id AND a IN(challenger_id,opponent_id) AND remaining_escrow>0) THEN RAISE EXCEPTION 'identity_locked_during_challenge' USING ERRCODE='PT409'; END IF;
 INSERT INTO race_private.driver_identities(tenant_id,user_id,provider,external_id) VALUES(p_tenant_id,a,p_provider,p_external_id) ON CONFLICT(tenant_id,user_id,provider) DO UPDATE SET external_id=excluded.external_id,verified_at=now();
 RETURN jsonb_build_object('provider',p_provider,'external_id',p_external_id,'verified',true); END $$;
CREATE FUNCTION public.sim_register_event(p_tenant_id uuid,p_provider_id uuid,p_event_id uuid,p_game text,p_external_session_id text,p_title text,p_track_name text,p_starts_at timestamptz,p_funding_closes_at timestamptz,p_deadline timestamptz,p_rule text,p_entrants jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old race_private.sim_events%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=p_tenant_id AND id=p_provider_id AND enabled) THEN RAISE EXCEPTION 'provider_unavailable' USING ERRCODE='PT403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('event:'||p_tenant_id::text||p_event_id::text,0));
 SELECT * INTO old FROM race_private.sim_events WHERE tenant_id=p_tenant_id AND id=p_event_id;
 IF FOUND THEN
 IF (old.provider_id,old.game,old.external_session_id,old.title,old.track_name,old.starts_at,old.funding_closes_at,old.deadline,old.rule,old.entrants) IS DISTINCT FROM(p_provider_id,p_game,p_external_session_id,p_title,p_track_name,p_starts_at,p_funding_closes_at,p_deadline,p_rule,p_entrants) THEN RAISE EXCEPTION 'event_terms_conflict' USING ERRCODE='PT409'; END IF;
 RETURN jsonb_build_object('event_id',old.id,'duplicate',true); END IF;
 IF p_funding_closes_at<=clock_timestamp() OR p_starts_at>=clock_timestamp()+interval '24 hours' OR jsonb_array_length(p_entrants)<2 THEN RAISE EXCEPTION 'invalid_future_event' USING ERRCODE='PT400'; END IF;
 INSERT INTO race_private.sim_events(tenant_id,id,provider_id,game,external_session_id,title,track_name,starts_at,funding_closes_at,deadline,rule,entrants) VALUES(p_tenant_id,p_event_id,p_provider_id,p_game,p_external_session_id,p_title,p_track_name,p_starts_at,p_funding_closes_at,p_deadline,p_rule,p_entrants);
 RETURN jsonb_build_object('event_id',p_event_id,'duplicate',false); END $$;
CREATE FUNCTION public.sim_result_context(p_tenant_id uuid,p_challenge_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('tenant_id',c.tenant_id,'challenge_id',c.id,'session_id',c.session_id,'challenger_id',c.challenger_id,'opponent_id',c.opponent_id,'provider_id',c.provider_id,'status',c.status,'deadline',c.telemetry_deadline,'event_id',e.id,'external_session_id',e.external_session_id,'track_name',e.track_name,'starts_at',e.starts_at,'funded_at',s.funded_at,'game',s.game,'rule',s.rule,'selection_a',s.selection_a,'selection_b',s.selection_b) FROM race_private.sim_contracts s JOIN race_private.challenges c ON c.tenant_id=s.tenant_id AND c.id=s.challenge_id JOIN race_private.sim_events e ON e.tenant_id=s.tenant_id AND e.id=s.event_id WHERE s.tenant_id=p_tenant_id AND s.challenge_id=p_challenge_id
$$;
CREATE FUNCTION public.sim_provider_contracts(p_tenant_id uuid,p_provider_id uuid,p_external_session_id text,p_after uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(race_private_context),'[]'::jsonb) FROM(SELECT public.sim_result_context(c.tenant_id,c.id) AS race_private_context FROM race_private.challenges c JOIN race_private.sim_contracts s ON s.tenant_id=c.tenant_id AND s.challenge_id=c.id JOIN race_private.sim_events e ON e.tenant_id=s.tenant_id AND e.id=s.event_id WHERE c.tenant_id=p_tenant_id AND c.provider_id=p_provider_id AND e.external_session_id=p_external_session_id AND c.status='Active' AND(p_after IS NULL OR c.id>p_after) ORDER BY c.id LIMIT 100) pending
$$;
CREATE FUNCTION public.sim_commit_result(p_tenant_id uuid,p_provider_id uuid,p_challenge_id uuid,p_source_id text,p_external_session_id text,p_track_name text,p_actual_start timestamptz,p_payload_sha256 text,p_resolution text,p_best_a numeric,p_best_b numeric,p_summary jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c race_private.challenges%ROWTYPE;s race_private.sim_contracts%ROWTYPE;e race_private.sim_events%ROWTYPE;win uuid;resolution text;r jsonb;v race_private.provider_evidence%ROWTYPE;
BEGIN SELECT * INTO c FROM race_private.challenges WHERE tenant_id=p_tenant_id AND id=p_challenge_id FOR UPDATE;
 SELECT * INTO s FROM race_private.sim_contracts WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id;
 SELECT * INTO e FROM race_private.sim_events WHERE tenant_id=p_tenant_id AND id=s.event_id;
 IF c.id IS NULL OR s.challenge_id IS NULL OR (c.provider_id,e.external_session_id,e.track_name) IS DISTINCT FROM(p_provider_id,p_external_session_id,p_track_name) THEN RAISE EXCEPTION 'source_binding_mismatch' USING ERRCODE='PT403'; END IF;
 IF p_actual_start IS NULL OR p_actual_start<=s.funded_at OR p_actual_start>clock_timestamp() OR abs(extract(epoch FROM(p_actual_start-e.starts_at)))>300 THEN RAISE EXCEPTION 'historical_or_wrong_session' USING ERRCODE='PT403'; END IF;
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=p_tenant_id AND id=p_provider_id AND enabled) THEN RAISE EXCEPTION 'provider_unavailable' USING ERRCODE='PT403'; END IF;
 SELECT * INTO v FROM race_private.provider_evidence WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id;
 IF FOUND THEN IF (v.source_id,v.sha256) IS DISTINCT FROM(p_source_id,p_payload_sha256) THEN RAISE EXCEPTION 'evidence_conflict' USING ERRCODE='PT409'; END IF;
 RETURN (SELECT result||jsonb_build_object('duplicate',true) FROM race_private.telemetry_events WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id); END IF;
 IF p_source_id IS NULL OR length(p_source_id) NOT BETWEEN 1 AND 180 OR p_payload_sha256!~'^[0-9a-f]{64}$' OR p_summary IS NULL THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='PT400'; END IF;
 IF (p_best_a IS NOT NULL AND NOT(p_best_a>0 AND p_best_a<=86400 AND p_best_a=trunc(p_best_a,6))) OR(p_best_b IS NOT NULL AND NOT(p_best_b>0 AND p_best_b<=86400 AND p_best_b=trunc(p_best_b,6))) THEN RAISE EXCEPTION 'invalid_metrics' USING ERRCODE='PT400'; END IF;
 IF p_resolution='network_drop' THEN resolution:='network_drop';
 ELSIF p_best_a IS NULL AND p_best_b IS NULL THEN resolution:='no_clean_laps';
 ELSIF p_best_a=p_best_b THEN resolution:='tie';
 ELSE resolution:='winner';win:=CASE WHEN p_best_b IS NULL OR(p_best_a IS NOT NULL AND p_best_a<p_best_b) THEN c.challenger_id ELSE c.opponent_id END; END IF;
 IF p_resolution IS DISTINCT FROM resolution THEN RAISE EXCEPTION 'decision_mismatch' USING ERRCODE='PT400'; END IF;
 r:=race_private.finish_challenge(p_tenant_id,c.id,c.provider_id,'sim:'||p_source_id,p_payload_sha256,resolution::race_private.resolution,win,p_best_a,p_best_b);
 INSERT INTO race_private.provider_evidence VALUES(p_tenant_id,p_challenge_id,p_source_id,p_payload_sha256,p_summary,now());
 UPDATE race_private.result_jobs SET state='Done',lease_token=NULL,lease_until=NULL WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id;
 RETURN r; END $$;
CREATE FUNCTION public.sim_lease_jobs(p_limit integer DEFAULT 5) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb;
BEGIN WITH due AS(SELECT j.tenant_id,j.challenge_id FROM race_private.result_jobs j JOIN race_private.challenges c ON c.tenant_id=j.tenant_id AND c.id=j.challenge_id WHERE j.available_at<=now() AND(j.state='Queued' OR(j.state='Leased' AND j.lease_until<now())) AND c.status='Active' AND c.telemetry_deadline>now() ORDER BY j.available_at FOR UPDATE OF j SKIP LOCKED LIMIT least(greatest(p_limit,1),10)), leased AS(UPDATE race_private.result_jobs j SET state='Leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' FROM due WHERE j.tenant_id=due.tenant_id AND j.challenge_id=due.challenge_id RETURNING j.*) SELECT coalesce(jsonb_agg(row_to_json(leased)),'[]'::jsonb) INTO r FROM leased;RETURN r; END $$;
CREATE FUNCTION public.sim_retry_job(p_tenant_id uuid,p_challenge_id uuid,p_lease_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE race_private.result_jobs SET state='Queued',available_at=now()+interval '60 seconds',lease_token=NULL,lease_until=NULL WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id AND state='Leased' AND lease_token=p_lease_token;RETURN FOUND;END $$;

CREATE FUNCTION public.sim_oauth_begin(p_tenant_id uuid,p_auth_user_id uuid,p_provider text,p_state_hash text,p_verifier_cipher text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;
BEGIN SELECT id INTO a FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=p_auth_user_id AND enabled;
 IF a IS NULL THEN RAISE EXCEPTION 'profile_required' USING ERRCODE='PT409'; END IF;
 DELETE FROM race_private.oauth_states WHERE expires_at<now();
 INSERT INTO race_private.oauth_states VALUES(p_state_hash,p_tenant_id,a,p_provider,p_verifier_cipher,now()+interval '10 minutes',NULL);RETURN true;END $$;
CREATE FUNCTION public.sim_oauth_consume(p_state_hash text,p_provider text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s race_private.oauth_states%ROWTYPE;a uuid;
BEGIN UPDATE race_private.oauth_states SET consumed_at=now() WHERE state_hash=p_state_hash AND provider=p_provider AND consumed_at IS NULL AND expires_at>now() RETURNING * INTO s;
 IF NOT FOUND THEN RAISE EXCEPTION 'expired_or_replayed_oauth' USING ERRCODE='PT403'; END IF;
 SELECT auth_user_id INTO a FROM race_private.users WHERE tenant_id=s.tenant_id AND id=s.user_id;
 RETURN jsonb_build_object('tenant_id',s.tenant_id,'auth_user_id',a,'user_id',s.user_id,'verifier_cipher',s.verifier_cipher);END $$;
CREATE FUNCTION public.sim_store_token(p_tenant_id uuid,p_auth_user_id uuid,p_cipher text,p_expires_at timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;
BEGIN SELECT id INTO a FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=p_auth_user_id;
 IF a IS NULL THEN RAISE EXCEPTION 'profile_required' USING ERRCODE='PT409'; END IF;
 INSERT INTO race_private.oauth_tokens(tenant_id,user_id,provider,cipher,expires_at,version) VALUES(p_tenant_id,a,'iracing',p_cipher,p_expires_at,1) ON CONFLICT(tenant_id,user_id,provider) DO UPDATE SET cipher=excluded.cipher,expires_at=excluded.expires_at,version=race_private.oauth_tokens.version+1,refresh_lease=NULL,refresh_started_at=NULL;RETURN true;END $$;
-- Token refresh is serialized with a durable one-use lease. A lost external
-- token response requires reconnecting; it never resubmits a consumed refresh token.
CREATE FUNCTION public.sim_token_lease(p_tenant_id uuid,p_auth_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;o race_private.oauth_tokens%ROWTYPE;l uuid;
BEGIN SELECT id INTO a FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=p_auth_user_id;
 SELECT * INTO o FROM race_private.oauth_tokens WHERE tenant_id=p_tenant_id AND user_id=a AND provider='iracing' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('mode','reconnect');END IF;
 IF o.expires_at>now()+interval '2 minutes' THEN RETURN jsonb_build_object('mode','access','cipher',o.cipher); END IF;
 IF o.refresh_started_at IS NOT NULL THEN RETURN jsonb_build_object('mode',CASE WHEN o.refresh_started_at>now()-interval '1 minute' THEN 'busy' ELSE 'reconnect' END);END IF;
 l:=gen_random_uuid();UPDATE race_private.oauth_tokens SET refresh_lease=l,refresh_started_at=now() WHERE tenant_id=p_tenant_id AND user_id=a AND provider='iracing';
 RETURN jsonb_build_object('mode','refresh','cipher',o.cipher,'lease',l,'version',o.version);END $$;
CREATE FUNCTION public.sim_token_commit(p_tenant_id uuid,p_auth_user_id uuid,p_lease uuid,p_version integer,p_cipher text,p_expires_at timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;o race_private.oauth_tokens%ROWTYPE;
BEGIN SELECT id INTO a FROM race_private.users WHERE tenant_id=p_tenant_id AND auth_user_id=p_auth_user_id;
 SELECT * INTO o FROM race_private.oauth_tokens WHERE tenant_id=p_tenant_id AND user_id=a AND provider='iracing' FOR UPDATE;
 IF o.version=p_version+1 AND o.cipher=p_cipher THEN RETURN true;END IF;
 IF o.refresh_lease IS DISTINCT FROM p_lease OR o.version IS DISTINCT FROM p_version OR p_lease IS NULL THEN RAISE EXCEPTION 'refresh_lease_conflict' USING ERRCODE='PT409';END IF;
 UPDATE race_private.oauth_tokens SET cipher=p_cipher,expires_at=p_expires_at,version=version+1,refresh_lease=NULL,refresh_started_at=NULL WHERE tenant_id=p_tenant_id AND user_id=a AND provider='iracing';RETURN true;END $$;
CREATE FUNCTION public.sim_get_token(p_tenant_id uuid,p_auth_user_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('cipher',o.cipher,'expires_at',o.expires_at) FROM race_private.oauth_tokens o JOIN race_private.users u ON u.tenant_id=o.tenant_id AND u.id=o.user_id WHERE o.tenant_id=p_tenant_id AND u.auth_user_id=p_auth_user_id AND o.expires_at>now()+interval '30 seconds'
$$;

CREATE FUNCTION public.sim_catalog(p_tenant_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);
BEGIN RETURN jsonb_build_object('packages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'amount_cents',amount_cents,'gc',gc::text,'sc',sc::text)) FROM race_private.commerce_catalog WHERE tenant_id=p_tenant_id AND enabled),'[]'::jsonb));END $$;
CREATE FUNCTION public.sim_create_order(p_tenant_id uuid,p_order_id uuid,p_package_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE a uuid:=race_private.customer_wallet(p_tenant_id);o race_private.commerce_orders%ROWTYPE;c race_private.commerce_catalog%ROWTYPE;
BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('order:'||p_tenant_id::text||p_order_id::text,0));
 SELECT * INTO o FROM race_private.commerce_orders WHERE tenant_id=p_tenant_id AND id=p_order_id;
 IF FOUND THEN IF o.user_id<>a OR o.package_id<>p_package_id THEN RAISE EXCEPTION 'order_conflict' USING ERRCODE='PT409'; END IF; RETURN to_jsonb(o)||jsonb_build_object('gc',o.gc::text,'sc',o.sc::text); END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=a FOR NO KEY UPDATE;PERFORM race_private.customer_can_play(p_tenant_id,a,'GC');
 IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled AND commerce_enabled) OR EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=p_tenant_id AND user_id=a AND payment_review) THEN RAISE EXCEPTION 'commerce_not_available' USING ERRCODE='PT403'; END IF;
 SELECT * INTO c FROM race_private.commerce_catalog WHERE tenant_id=p_tenant_id AND id=p_package_id AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable' USING ERRCODE='PT404'; END IF;
 IF c.sc>0 THEN PERFORM race_private.customer_can_play(p_tenant_id,a,'SC');END IF;
 INSERT INTO race_private.commerce_orders(tenant_id,id,user_id,package_id,amount_cents,gc,sc) VALUES(p_tenant_id,p_order_id,a,p_package_id,c.amount_cents,c.gc,c.sc) RETURNING * INTO o;
 RETURN to_jsonb(o)||jsonb_build_object('gc',o.gc::text,'sc',o.sc::text); END $$;
CREATE FUNCTION public.fulfill_coin_purchase(p_tenant_id uuid,p_order_id uuid,p_stripe_session text,p_stripe_intent text,p_stripe_event text,p_amount_paid_cents integer,p_currency text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE o race_private.commerce_orders%ROWTYPE;ledger race_private.payment_ledgers%ROWTYPE;
BEGIN
 IF p_stripe_intent IS NULL OR p_stripe_intent!~'^pi_[A-Za-z0-9]+$' OR p_stripe_session!~'^cs_[A-Za-z0-9_]+$' OR p_stripe_event!~'^evt_[A-Za-z0-9]+$' THEN RAISE EXCEPTION 'invalid_payment_receipt' USING ERRCODE='PT400'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stripe-intent:'||p_stripe_intent,0));
 SELECT * INTO ledger FROM race_private.payment_ledgers WHERE stripe_payment_intent=p_stripe_intent;
 IF FOUND THEN IF(ledger.tenant_id,ledger.order_id,ledger.amount_cents) IS DISTINCT FROM(p_tenant_id,p_order_id,p_amount_paid_cents) THEN RAISE EXCEPTION 'payment_conflict' USING ERRCODE='PT409'; END IF;RETURN jsonb_build_object('status','Paid','duplicate',true);END IF;
 SELECT * INTO o FROM race_private.commerce_orders WHERE tenant_id=p_tenant_id AND id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.state<>'Created' OR(o.amount_cents,o.currency) IS DISTINCT FROM(p_amount_paid_cents,p_currency) THEN RAISE EXCEPTION 'order_payment_mismatch' USING ERRCODE='PT409'; END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=p_tenant_id AND id=o.user_id FOR NO KEY UPDATE;
 PERFORM race_private.credit_wallet(p_tenant_id,o.user_id,'GC',o.gc,'purchase:'||o.id::text||':GC');
 IF o.sc>0 THEN PERFORM race_private.credit_wallet(p_tenant_id,o.user_id,'SC',o.sc,'purchase:'||o.id::text||':SC'); END IF;
 INSERT INTO race_private.payment_ledgers VALUES(p_stripe_intent,p_tenant_id,o.id,p_amount_paid_cents,p_stripe_event,now());
 IF EXISTS(SELECT 1 FROM race_private.payment_cases WHERE stripe_payment_intent=p_stripe_intent) THEN UPDATE race_private.profiles SET payment_review=true WHERE tenant_id=p_tenant_id AND user_id=o.user_id;END IF;
 UPDATE race_private.commerce_orders SET state=CASE WHEN EXISTS(SELECT 1 FROM race_private.payment_cases WHERE stripe_payment_intent=p_stripe_intent) THEN 'Review' ELSE 'Paid' END,stripe_session_id=p_stripe_session WHERE tenant_id=p_tenant_id AND id=o.id;
 RETURN jsonb_build_object('status','Paid','duplicate',false);END $$;
CREATE FUNCTION public.sim_payment_review(p_stripe_event text,p_stripe_intent text,p_reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l race_private.payment_ledgers%ROWTYPE;o race_private.commerce_orders%ROWTYPE;
BEGIN INSERT INTO race_private.payment_cases(stripe_event_id,stripe_payment_intent,reason) VALUES(p_stripe_event,p_stripe_intent,p_reason) ON CONFLICT DO NOTHING;
 SELECT * INTO l FROM race_private.payment_ledgers WHERE stripe_payment_intent=p_stripe_intent;
 IF FOUND THEN SELECT * INTO o FROM race_private.commerce_orders WHERE tenant_id=l.tenant_id AND id=l.order_id;
 PERFORM id FROM race_private.users WHERE tenant_id=o.tenant_id AND id=o.user_id FOR NO KEY UPDATE;
 UPDATE race_private.profiles SET payment_review=true WHERE tenant_id=o.tenant_id AND user_id=o.user_id;
 UPDATE race_private.commerce_orders SET state='Review' WHERE tenant_id=o.tenant_id AND id=o.id;END IF;RETURN true;END $$;
CREATE FUNCTION public.sim_discord_offer(p_tenant_id uuid,p_actor_discord text,p_opponent_discord text,p_request_id uuid,p_event_id uuid,p_token_type text,p_entry_fee text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;b uuid;
BEGIN SELECT user_id INTO a FROM race_private.driver_identities WHERE tenant_id=p_tenant_id AND provider='discord' AND external_id=p_actor_discord;
 SELECT user_id INTO b FROM race_private.driver_identities WHERE tenant_id=p_tenant_id AND provider='discord' AND external_id=p_opponent_discord;
 IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'verified_discord_accounts_required' USING ERRCODE='PT403'; END IF;
 RETURN race_private.sim_offer_internal(p_tenant_id,a,p_request_id,p_event_id,'driver_duel',p_token_type,p_entry_fee,NULL,b);END $$;
CREATE FUNCTION public.sim_discord_accept(p_tenant_id uuid,p_actor_discord text,p_offer_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid;
BEGIN SELECT user_id INTO a FROM race_private.driver_identities WHERE tenant_id=p_tenant_id AND provider='discord' AND external_id=p_actor_discord;
 IF a IS NULL THEN RAISE EXCEPTION 'verified_discord_account_required' USING ERRCODE='PT403'; END IF;
 RETURN race_private.sim_accept_internal(p_tenant_id,a,p_offer_id,true,NULL);END $$;
CREATE OR REPLACE FUNCTION race_private.settle_challenge(
  p_tenant_id uuid, p_provider_id uuid, p_challenge_id uuid, p_session_id uuid,
  p_event_id uuid, p_payload_sha256 text, p_challenger_id uuid, p_opponent_id uuid,
  p_resolution text, p_winner_id uuid, p_challenger_best numeric, p_opponent_best numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '3s' SET statement_timeout = '10s' AS $$
DECLARE c race_private.challenges%ROWTYPE; v_expected uuid; v_resolution text;
BEGIN
  IF EXISTS(SELECT 1 FROM race_private.sim_contracts WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id) THEN RAISE EXCEPTION 'sim_provider_evidence_required' USING ERRCODE='PT403'; END IF;
  IF p_event_id IS NULL OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
    OR p_resolution IS NULL OR p_resolution NOT IN ('winner','tie','no_clean_laps','network_drop') THEN
    RAISE EXCEPTION 'invalid_event' USING ERRCODE='PT400';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM race_private.providers WHERE tenant_id=p_tenant_id AND id=p_provider_id AND enabled) THEN
    RAISE EXCEPTION 'provider_unavailable' USING ERRCODE='PT403';
  END IF;
  SELECT * INTO c FROM race_private.challenges WHERE tenant_id=p_tenant_id AND id=p_challenge_id FOR UPDATE;
  IF NOT FOUND OR (c.provider_id,c.session_id,c.challenger_id,c.opponent_id)
      IS DISTINCT FROM (p_provider_id,p_session_id,p_challenger_id,p_opponent_id) THEN
    RAISE EXCEPTION 'challenge_binding_mismatch' USING ERRCODE='PT404';
  END IF;
  IF (p_challenger_best IS NOT NULL AND NOT (p_challenger_best>0 AND p_challenger_best<=86400 AND p_challenger_best=trunc(p_challenger_best,6)))
    OR (p_opponent_best IS NOT NULL AND NOT (p_opponent_best>0 AND p_opponent_best<=86400 AND p_opponent_best=trunc(p_opponent_best,6))) THEN
    RAISE EXCEPTION 'invalid_lap_summary' USING ERRCODE='PT400';
  END IF;
  IF p_resolution = 'network_drop' THEN
    v_resolution := 'network_drop';
  ELSIF p_challenger_best IS NULL AND p_opponent_best IS NULL THEN
    v_resolution := 'no_clean_laps';
  ELSIF p_challenger_best = p_opponent_best THEN v_resolution := 'tie';
  ELSE
    v_resolution := 'winner';
    v_expected := CASE WHEN p_opponent_best IS NULL OR
      (p_challenger_best IS NOT NULL AND p_challenger_best<p_opponent_best)
      THEN c.challenger_id ELSE c.opponent_id END;
  END IF;
  IF p_resolution<>v_resolution OR p_winner_id IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'decision_mismatch' USING ERRCODE='PT400';
  END IF;
  RETURN race_private.finish_challenge(p_tenant_id,c.id,p_provider_id,p_event_id::text,
    p_payload_sha256,p_resolution::race_private.resolution,p_winner_id,p_challenger_best,p_opponent_best);
END;
$$;


-- No customer may fund historical practice providers after this migration.
REVOKE EXECUTE ON FUNCTION public.race_offer(uuid,uuid,text,text,text),public.race_accept(uuid,uuid,boolean),public.race_lobby(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION race_private.customer_offer(uuid,uuid,text,text,text),race_private.customer_accept(uuid,uuid,boolean),race_private.customer_lobby(uuid) FROM authenticated;
DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure AS sig,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND(p.proname LIKE 'sim_%' OR p.proname='fulfill_coin_purchase') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
 IF f.proname IN('sim_offer','sim_accept','sim_cancel','sim_state','sim_lobby','sim_request_result','sim_catalog','sim_create_order') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.sig);
 ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig); END IF;
 END LOOP;
 REVOKE ALL ON FUNCTION race_private.sim_offer_internal(uuid,uuid,uuid,uuid,text,text,text,text,uuid),race_private.sim_accept_internal(uuid,uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
END $$;
COMMIT;


-- Source: supabase/migrations/20261006092644_institutional_controls.sql
-- Apply after the external simulator migration. The enum label is committed
-- before use, as required by PostgreSQL. All financial/control DDL below is atomic.
BEGIN;
ALTER TYPE race_private.challenge_status ADD VALUE IF NOT EXISTS 'Refunded';
COMMIT;
BEGIN;
ALTER TYPE race_private.token_type RENAME TO currency_type;
DO $$ DECLARE f record; definition text; BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN('race_private','public') AND p.prokind='f' LOOP
  definition:=pg_get_functiondef(f.oid);
  IF position('race_private.token_type' IN definition)>0 THEN
   EXECUTE replace(definition,'race_private.token_type','race_private.currency_type');
  END IF;
 END LOOP;
END $$;
ALTER TABLE race_private.users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE race_private.users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE race_private.challenges ADD COLUMN platform_rake_withheld numeric(24,6) GENERATED ALWAYS AS(platform_rake) STORED;
ALTER TABLE race_private.challenges ADD COLUMN prize_pool numeric(24,6) GENERATED ALWAYS AS(total_escrow_pool-platform_rake) STORED;
ALTER TABLE race_private.sim_events ADD COLUMN min_lap_seconds numeric(18,6) NOT NULL DEFAULT 1 CHECK(min_lap_seconds>0);
ALTER TABLE race_private.sim_events ADD COLUMN max_lap_seconds numeric(18,6) NOT NULL DEFAULT 3600 CHECK(max_lap_seconds>min_lap_seconds AND max_lap_seconds<=86400);
ALTER TABLE race_private.payment_ledgers ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE race_private.payment_ledgers ADD COLUMN user_id uuid;
ALTER TABLE race_private.payment_ledgers ADD COLUMN status text NOT NULL DEFAULT 'Paid' CHECK(status='Paid');
ALTER TABLE race_private.payment_ledgers DISABLE TRIGGER payments_immutable;
UPDATE race_private.payment_ledgers l SET user_id=o.user_id FROM race_private.commerce_orders o WHERE(l.tenant_id,l.order_id)=(o.tenant_id,o.id);
ALTER TABLE race_private.payment_ledgers ENABLE TRIGGER payments_immutable;
ALTER TABLE race_private.payment_ledgers ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE race_private.payment_ledgers ADD CONSTRAINT payment_user FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id);
CREATE UNIQUE INDEX payment_receipt_id ON race_private.payment_ledgers(id);
DO $$ DECLARE definition text; c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='race_private.challenges'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
  EXECUTE format('ALTER TABLE race_private.challenges DROP CONSTRAINT %I',c.conname);
 END LOOP;
 definition:=pg_get_functiondef('race_private.finish_challenge(uuid,uuid,uuid,text,text,race_private.resolution,uuid,numeric,numeric,boolean)'::regprocedure);
 definition:=replace(definition,$old$status='Settled',remaining_escrow=0$old$, $new$status=CASE WHEN p_resolution='winner' THEN 'Settled'::race_private.challenge_status ELSE 'Refunded'::race_private.challenge_status END,remaining_escrow=0$new$);
 definition:=replace(definition,$old$'status','Settled','resolution'$old$, $new$'status',CASE WHEN p_resolution='winner' THEN 'Settled' ELSE 'Refunded' END,'resolution'$new$);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.fulfill_coin_purchase(uuid,uuid,text,text,text,integer,text)'::regprocedure);
 definition:=replace(definition,'INSERT INTO race_private.payment_ledgers VALUES(p_stripe_intent,p_tenant_id,o.id,p_amount_paid_cents,p_stripe_event,now());',
  'INSERT INTO race_private.payment_ledgers(stripe_payment_intent,tenant_id,order_id,amount_cents,stripe_event_id,created_at,user_id) VALUES(p_stripe_intent,p_tenant_id,o.id,p_amount_paid_cents,p_stripe_event,now(),o.user_id);');
 EXECUTE definition;
END $$;
UPDATE race_private.challenges SET status='Refunded' WHERE status='Settled' AND resolution<>'winner';
ALTER TABLE race_private.challenges ADD CONSTRAINT challenge_financial_state CHECK(
 (status IN('Pending','Active','Disputed') AND remaining_escrow=total_escrow_pool AND resolution IS NULL AND winner_id IS NULL AND settled_at IS NULL AND rake_charged=0)
 OR(status='Settled' AND remaining_escrow=0 AND resolution='winner' AND winner_id IS NOT NULL AND settled_at IS NOT NULL AND rake_charged=platform_rake)
 OR(status='Refunded' AND remaining_escrow=0 AND resolution IS NOT NULL AND resolution<>'winner' AND winner_id IS NULL AND settled_at IS NOT NULL AND rake_charged=0));

CREATE TABLE race_private.promotion_programs (
 tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),id uuid NOT NULL,version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),sponsor text NOT NULL CHECK(length(sponsor) BETWEEN 1 AND 200),
 official_rules_url text NOT NULL CHECK(official_rules_url~'^https://[^[:space:]]+$'),rules_sha256 text NOT NULL CHECK(rules_sha256~'^[0-9a-f]{64}$'),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,minimum_age integer NOT NULL CHECK(minimum_age BETWEEN 18 AND 100),
 territories jsonb NOT NULL CHECK(jsonb_typeof(territories)='array' AND jsonb_array_length(territories) BETWEEN 1 AND 100),
 free_sc numeric(24,6) NOT NULL CHECK(free_sc>0 AND free_sc<=1000),period_hours integer NOT NULL CHECK(period_hours BETWEEN 1 AND 720),
 entries_per_period integer NOT NULL CHECK(entries_per_period BETWEEN 1 AND 100),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,version),CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '366 days')
);
CREATE TABLE race_private.program_activations (
 tenant_id uuid PRIMARY KEY REFERENCES race_private.tenants(id),program_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,
 FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id)
);
CREATE TABLE race_private.program_consents (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,program_id uuid NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),
 source text NOT NULL DEFAULT 'web' CHECK(source IN('web','discord')),PRIMARY KEY(tenant_id,user_id,program_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id)
);
CREATE TABLE race_private.program_changes (
 tenant_id uuid NOT NULL,id uuid NOT NULL,provider_id uuid NOT NULL,program_id uuid NOT NULL,action text NOT NULL CHECK(action IN('published','activated','disabled')),
 authorization_reference text NOT NULL CHECK(length(authorization_reference) BETWEEN 10 AND 500),payload_sha256 text NOT NULL CHECK(payload_sha256~'^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id)
);
CREATE TABLE race_private.compliance_receipts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,provider_id uuid NOT NULL,user_id uuid NOT NULL,purpose text NOT NULL CHECK(purpose IN('identity','location','risk')),
 decision text NOT NULL CHECK(decision IN('approved','denied','review')),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 160),
 observed_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,subject_key text CHECK(subject_key~'^[0-9a-f]{64}$'),
 age_threshold integer CHECK(age_threshold BETWEEN 18 AND 100),territory text CHECK(territory~'^[A-Z]{2}-[A-Z0-9]{1,4}$'),
 proxy_detected boolean NOT NULL DEFAULT false,payload_sha256 text NOT NULL CHECK(payload_sha256~'^[0-9a-f]{64}$'),received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),
 FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),CHECK(valid_until>observed_at),
 CHECK(decision<>'approved' OR purpose<>'identity' OR(subject_key IS NOT NULL AND age_threshold IS NOT NULL)),
 CHECK(decision<>'approved' OR purpose<>'location' OR(territory IS NOT NULL AND NOT proxy_detected))
);
CREATE INDEX compliance_receipt_user ON race_private.compliance_receipts(tenant_id,user_id,purpose,observed_at DESC);
CREATE TABLE race_private.compliance_current (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,purpose text NOT NULL,receipt_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,user_id,purpose),FOREIGN KEY(tenant_id,receipt_id) REFERENCES race_private.compliance_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.compliance_subjects (
 tenant_id uuid NOT NULL,subject_key text NOT NULL CHECK(subject_key~'^[0-9a-f]{64}$'),user_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,subject_key),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.risk_cases (
 tenant_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,receipt_id uuid NOT NULL,reason text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,receipt_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,receipt_id) REFERENCES race_private.compliance_receipts(tenant_id,id)
);
CREATE TABLE race_private.risk_resolutions (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,provider_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 payload_sha256 text NOT NULL CHECK(payload_sha256~'^[0-9a-f]{64}$'),resolved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,case_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES race_private.risk_cases(tenant_id,id),FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id)
);
CREATE TABLE race_private.ame_requests (
 tenant_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,program_id uuid NOT NULL,
 token_type race_private.currency_type NOT NULL DEFAULT 'SC' CHECK(token_type='SC'),period_start timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('Credited','Rejected')),reason text NOT NULL,amount numeric(24,6) NOT NULL CHECK(amount>=0),
 identity_receipt uuid,location_receipt uuid,journal_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id),
 FOREIGN KEY(tenant_id,identity_receipt) REFERENCES race_private.compliance_receipts(tenant_id,id),FOREIGN KEY(tenant_id,location_receipt) REFERENCES race_private.compliance_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,journal_id) REFERENCES race_private.journal_transactions(tenant_id,id),
 CHECK((state='Credited')=(journal_id IS NOT NULL AND amount>0 AND identity_receipt IS NOT NULL AND location_receipt IS NOT NULL))
);
CREATE INDEX ame_period_quota ON race_private.ame_requests(tenant_id,user_id,program_id,period_start) WHERE state='Credited';
CREATE TABLE race_private.request_budgets (
 tenant_id uuid NOT NULL REFERENCES race_private.tenants(id),auth_user_id uuid NOT NULL,operation text NOT NULL,window_start timestamptz NOT NULL,used integer NOT NULL CHECK(used>0),
 PRIMARY KEY(tenant_id,auth_user_id,operation,window_start)
);
CREATE INDEX request_budgets_expiry ON race_private.request_budgets(window_start);
CREATE TABLE race_private.audit_heads (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),hash text NOT NULL DEFAULT repeat('0',64) CHECK(hash~'^[0-9a-f]{64}$'),
 PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id)
);
CREATE TABLE race_private.journal_seals (
 tenant_id uuid NOT NULL,transaction_id uuid NOT NULL,payload jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[0-9a-f]{64}$'),
 PRIMARY KEY(tenant_id,transaction_id),FOREIGN KEY(tenant_id,transaction_id) REFERENCES race_private.journal_transactions(tenant_id,id)
);
CREATE TABLE race_private.audit_records (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,sequence bigint NOT NULL,transaction_id uuid NOT NULL,previous_hash text NOT NULL CHECK(previous_hash~'^[0-9a-f]{64}$'),
 hash text NOT NULL CHECK(hash~'^[0-9a-f]{64}$'),payload jsonb NOT NULL,PRIMARY KEY(tenant_id,user_id,sequence),UNIQUE(tenant_id,user_id,transaction_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,transaction_id) REFERENCES race_private.journal_seals(tenant_id,transaction_id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['promotion_programs','program_activations','program_consents','program_changes','compliance_receipts','compliance_current','compliance_subjects','risk_cases','risk_resolutions','ame_requests','request_budgets','audit_heads','journal_seals','audit_records'] LOOP
  EXECUTE format('ALTER TABLE race_private.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('REVOKE ALL ON race_private.%I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['promotion_programs','program_consents','program_changes','compliance_receipts','compliance_subjects','risk_cases','risk_resolutions','ame_requests','journal_seals','audit_records'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON race_private.%I FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record()',n);
 END LOOP;
END $$;

CREATE FUNCTION race_private.grid_publish_program(t uuid,provider uuid,change uuid,program uuid,version text,title text,sponsor text,rules_url text,rules_hash text,starts timestamptz,ends timestamptz,age integer,territories jsonb,free_sc numeric,period_hours integer,entries integer,auth_reference text,sha text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE old race_private.program_changes%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=provider AND enabled) OR change IS NULL OR program IS NULL THEN RAISE EXCEPTION 'program_operator_required' USING ERRCODE='PT403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('program-change:'||t::text||change::text,0));
 SELECT * INTO old FROM race_private.program_changes WHERE tenant_id=t AND id=change;
 IF FOUND THEN IF(old.provider_id,old.program_id,old.payload_sha256,old.action) IS DISTINCT FROM(provider,program,sha,'published') THEN RAISE EXCEPTION 'program_change_conflict' USING ERRCODE='PT409'; END IF;RETURN jsonb_build_object('program_id',program,'duplicate',true);END IF;
 IF territories IS NULL OR jsonb_typeof(territories)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(territories) x WHERE x!~'^[A-Z]{2}-[A-Z0-9]{1,4}$')
  OR(jsonb_array_length(territories)<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(territories) x)) THEN RAISE EXCEPTION 'invalid_program_territories' USING ERRCODE='PT400'; END IF;
 INSERT INTO race_private.promotion_programs VALUES(t,program,version,title,sponsor,rules_url,rules_hash,starts,ends,age,territories,free_sc,period_hours,entries,now());
 INSERT INTO race_private.program_changes VALUES(t,change,provider,program,'published',auth_reference,sha,now());
 RETURN jsonb_build_object('program_id',program,'duplicate',false);
END $$;
CREATE FUNCTION race_private.grid_activate_program(t uuid,provider uuid,change uuid,program uuid,enabled boolean,auth_reference text,sha text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE old race_private.program_changes%ROWTYPE;p race_private.promotion_programs%ROWTYPE;action text:=CASE WHEN enabled THEN 'activated' ELSE 'disabled' END;
BEGIN
 IF enabled IS NULL OR change IS NULL OR NOT EXISTS(SELECT 1 FROM race_private.providers provider_row WHERE provider_row.tenant_id=t AND provider_row.id=provider AND provider_row.enabled) THEN RAISE EXCEPTION 'program_operator_required' USING ERRCODE='PT403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('program-change:'||t::text||change::text,0));
 SELECT * INTO old FROM race_private.program_changes WHERE tenant_id=t AND id=change;
 IF FOUND THEN IF(old.provider_id,old.program_id,old.payload_sha256,old.action) IS DISTINCT FROM(provider,program,sha,action) THEN RAISE EXCEPTION 'program_change_conflict' USING ERRCODE='PT409'; END IF;RETURN jsonb_build_object('program_id',program,'enabled',enabled,'duplicate',true);END IF;
 SELECT * INTO p FROM race_private.promotion_programs WHERE tenant_id=t AND id=program;
 IF NOT FOUND OR(enabled AND clock_timestamp()>=p.ends_at) THEN RAISE EXCEPTION 'program_unavailable' USING ERRCODE='PT409'; END IF;
 INSERT INTO race_private.program_activations VALUES(t,program,enabled) ON CONFLICT(tenant_id) DO UPDATE SET program_id=excluded.program_id,enabled=excluded.enabled;
 INSERT INTO race_private.program_changes VALUES(t,change,provider,program,action,auth_reference,sha,now());
 RETURN jsonb_build_object('program_id',program,'enabled',enabled,'duplicate',false);
END $$;
CREATE FUNCTION race_private.grid_install_catalog(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=t AND enabled) THEN RAISE EXCEPTION 'tenant_unavailable' USING ERRCODE='PT403';END IF;
 INSERT INTO race_private.commerce_catalog VALUES(t,'pack_bronze_10',1000,10000,10,false),(t,'pack_silver_20',2000,25000,22,false),(t,'pack_gold_50',5000,60000,55,false) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM race_private.commerce_catalog WHERE tenant_id=t AND((id='pack_bronze_10' AND(amount_cents,gc,sc) IS DISTINCT FROM(1000,10000::numeric,10::numeric))
  OR(id='pack_silver_20' AND(amount_cents,gc,sc) IS DISTINCT FROM(2000,25000::numeric,22::numeric)) OR(id='pack_gold_50' AND(amount_cents,gc,sc) IS DISTINCT FROM(5000,60000::numeric,55::numeric)))) THEN RAISE EXCEPTION 'published_catalog_conflict' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('installed',true,'enabled',false);
END $$;
CREATE FUNCTION race_private.grid_catalog_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN IF(NEW.tenant_id,NEW.id,NEW.amount_cents,NEW.gc,NEW.sc) IS DISTINCT FROM(OLD.tenant_id,OLD.id,OLD.amount_cents,OLD.gc,OLD.sc) THEN RAISE EXCEPTION 'catalog_terms_immutable' USING ERRCODE='PT409';END IF;RETURN NEW;END $$;
CREATE TRIGGER catalog_terms BEFORE UPDATE ON race_private.commerce_catalog FOR EACH ROW EXECUTE FUNCTION race_private.grid_catalog_guard();
CREATE FUNCTION race_private.grid_register_event(t uuid,provider uuid,event uuid,game text,external_session text,title text,track text,starts timestamptz,closes timestamptz,deadline timestamptz,rule text,entrants jsonb,min_lap numeric,max_lap numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb;e race_private.sim_events%ROWTYPE;
BEGIN
 IF min_lap IS NULL OR max_lap IS NULL OR min_lap<=0 OR max_lap<=min_lap OR max_lap>86400 OR min_lap<>trunc(min_lap,6) OR max_lap<>trunc(max_lap,6) THEN RAISE EXCEPTION 'invalid_lap_bounds' USING ERRCODE='PT400';END IF;
 r:=public.sim_register_event(t,provider,event,game,external_session,title,track,starts,closes,deadline,rule,entrants);
 SELECT * INTO e FROM race_private.sim_events WHERE tenant_id=t AND id=event;
 IF(r->>'duplicate')::boolean THEN IF(e.min_lap_seconds,e.max_lap_seconds) IS DISTINCT FROM(min_lap,max_lap) THEN RAISE EXCEPTION 'lap_bounds_conflict' USING ERRCODE='PT409';END IF;
 ELSE UPDATE race_private.sim_events SET min_lap_seconds=min_lap,max_lap_seconds=max_lap WHERE tenant_id=t AND id=event;END IF;
 RETURN r;
END $$;
CREATE FUNCTION race_private.grid_cleanup_budgets() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN WITH expired AS(SELECT ctid FROM race_private.request_budgets WHERE window_start<now()-interval '1 day' ORDER BY window_start FOR UPDATE SKIP LOCKED LIMIT 10000)
 DELETE FROM race_private.request_budgets WHERE ctid IN(SELECT ctid FROM expired);GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END $$;

CREATE FUNCTION race_private.grid_program(t uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'sponsor',p.sponsor,'official_rules_url',p.official_rules_url,'rules_sha256',p.rules_sha256,
 'starts_at',p.starts_at,'ends_at',p.ends_at,'minimum_age',p.minimum_age,'territories',p.territories,'free_sc',p.free_sc::text,
 'period_hours',p.period_hours,'entries_per_period',p.entries_per_period,'method','online_free_request')
 FROM race_private.promotion_programs p JOIN race_private.program_activations a ON(a.tenant_id,a.program_id)=(p.tenant_id,p.id)
 JOIN race_private.tenants x ON x.id=p.tenant_id WHERE p.tenant_id=t AND a.enabled AND x.enabled AND x.sc_enabled AND clock_timestamp()>=p.starts_at AND clock_timestamp()<p.ends_at
$$;
CREATE FUNCTION race_private.grid_eligibility(t uuid,u uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p jsonb:=race_private.grid_program(t);i race_private.compliance_receipts%ROWTYPE;l race_private.compliance_receipts%ROWTYPE;r race_private.compliance_receipts%ROWTYPE;why text;
BEGIN
 SELECT e.* INTO i FROM race_private.compliance_current c JOIN race_private.compliance_receipts e ON(e.tenant_id,e.id)=(c.tenant_id,c.receipt_id) WHERE c.tenant_id=t AND c.user_id=u AND c.purpose='identity';
 SELECT e.* INTO l FROM race_private.compliance_current c JOIN race_private.compliance_receipts e ON(e.tenant_id,e.id)=(c.tenant_id,c.receipt_id) WHERE c.tenant_id=t AND c.user_id=u AND c.purpose='location';
 SELECT e.* INTO r FROM race_private.compliance_current c JOIN race_private.compliance_receipts e ON(e.tenant_id,e.id)=(c.tenant_id,c.receipt_id) WHERE c.tenant_id=t AND c.user_id=u AND c.purpose='risk';
 why:=CASE WHEN p IS NULL THEN 'program_unavailable'
  WHEN EXISTS(SELECT 1 FROM race_private.risk_cases c WHERE c.tenant_id=t AND c.user_id=u AND NOT EXISTS(SELECT 1 FROM race_private.risk_resolutions z WHERE(z.tenant_id,z.case_id)=(c.tenant_id,c.id))) THEN 'account_review'
  WHEN NOT EXISTS(SELECT 1 FROM race_private.program_consents WHERE tenant_id=t AND user_id=u AND program_id=(p->>'id')::uuid) THEN 'rules_consent_required'
  WHEN i.id IS NULL OR i.decision<>'approved' OR i.valid_until<=clock_timestamp() OR i.age_threshold<(p->>'minimum_age')::integer THEN 'identity_verification_required'
  WHEN l.id IS NULL OR l.decision<>'approved' OR l.valid_until<=clock_timestamp() OR l.proxy_detected THEN 'location_verification_required'
  WHEN NOT(p->'territories' ? l.territory) THEN 'territory_unavailable'
  WHEN r.id IS NOT NULL AND(r.decision<>'approved' OR r.valid_until<=clock_timestamp()) THEN 'risk_verification_required'
  ELSE 'eligible' END;
 RETURN jsonb_build_object('eligible',why='eligible','reason',why,'program',p,'identity_receipt',i.id,'location_receipt',l.id,
  'identity_expires_at',i.valid_until,'location_expires_at',l.valid_until,'consent_recorded',p IS NOT NULL AND EXISTS(SELECT 1 FROM race_private.program_consents WHERE tenant_id=t AND user_id=u AND program_id=(p->>'id')::uuid));
END $$;
CREATE OR REPLACE FUNCTION race_private.customer_can_play(p_tenant_id uuid,p_wallet uuid,p_currency text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_currency='SC' THEN PERFORM program_id FROM race_private.program_activations WHERE tenant_id=p_tenant_id FOR SHARE;END IF;
 IF p_currency IS NULL OR p_currency NOT IN('GC','SC') OR NOT EXISTS(SELECT 1 FROM race_private.users WHERE tenant_id=p_tenant_id AND id=p_wallet AND enabled)
  OR NOT EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=p_tenant_id AND user_id=p_wallet AND(pause_until IS NULL OR pause_until<=clock_timestamp()) AND NOT payment_review)
  OR NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=p_tenant_id AND enabled AND(p_currency='GC' OR sc_enabled))
  OR EXISTS(SELECT 1 FROM race_private.risk_cases c WHERE c.tenant_id=p_tenant_id AND c.user_id=p_wallet AND NOT EXISTS(SELECT 1 FROM race_private.risk_resolutions r WHERE(r.tenant_id,r.case_id)=(c.tenant_id,c.id)))
  OR(p_currency='SC' AND coalesce((race_private.grid_eligibility(p_tenant_id,p_wallet)->>'eligible')::boolean,false)=false)
 THEN RAISE EXCEPTION 'play_or_currency_unavailable' USING ERRCODE='PT403'; END IF;
END $$;
CREATE FUNCTION race_private.grid_record_compliance(t uuid,provider uuid,receipt uuid,auth_actor uuid,purpose text,decision text,reason text,observed timestamptz,expires timestamptz,subject text,age integer,territory text,proxy boolean,sha text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid;old race_private.compliance_receipts%ROWTYPE;current_observed timestamptz;owner uuid;effective text:=decision;effective_reason text:=reason;
BEGIN
 IF receipt IS NULL OR purpose IS NULL OR purpose NOT IN('identity','location','risk') OR decision IS NULL OR decision NOT IN('approved','denied','review')
  OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 160 OR observed IS NULL OR expires IS NULL OR observed>clock_timestamp()+interval '30 seconds'
  OR observed<clock_timestamp()-interval '24 hours' OR expires<=observed OR expires>observed+(CASE WHEN purpose='identity' THEN interval '90 days' WHEN purpose='location' THEN interval '5 minutes' ELSE interval '15 minutes' END)
  OR sha IS NULL OR sha!~'^[0-9a-f]{64}$' OR proxy IS NULL THEN RAISE EXCEPTION 'invalid_compliance_receipt' USING ERRCODE='PT400'; END IF;
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=provider AND enabled) THEN RAISE EXCEPTION 'compliance_provider_unavailable' USING ERRCODE='PT403'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('compliance-receipt:'||t::text||receipt::text,0));
 SELECT * INTO old FROM race_private.compliance_receipts WHERE tenant_id=t AND id=receipt;
 IF FOUND THEN
  IF old.provider_id<>provider OR old.payload_sha256<>sha THEN RAISE EXCEPTION 'compliance_receipt_conflict' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('receipt_id',receipt,'decision',old.decision,'duplicate',true); END IF;
 SELECT id INTO u FROM race_private.users WHERE tenant_id=t AND auth_user_id=auth_actor AND enabled FOR NO KEY UPDATE;
 IF u IS NULL THEN RAISE EXCEPTION 'verified_customer_required' USING ERRCODE='PT404'; END IF;
 IF purpose='identity' AND decision='approved' THEN
  IF subject IS NULL OR subject!~'^[0-9a-f]{64}$' OR age IS NULL OR age NOT BETWEEN 18 AND 100 THEN RAISE EXCEPTION 'identity_evidence_required' USING ERRCODE='PT400'; END IF;
  INSERT INTO race_private.compliance_subjects VALUES(t,subject,u) ON CONFLICT DO NOTHING;
  SELECT user_id INTO owner FROM race_private.compliance_subjects WHERE tenant_id=t AND subject_key=subject;
  IF owner<>u THEN effective:='review';effective_reason:='identity_already_bound'; END IF;
 END IF;
 IF purpose='location' AND decision='approved' AND(territory IS NULL OR territory!~'^[A-Z]{2}-[A-Z0-9]{1,4}$' OR proxy) THEN RAISE EXCEPTION 'location_evidence_required' USING ERRCODE='PT400'; END IF;
 INSERT INTO race_private.compliance_receipts VALUES(t,receipt,provider,u,purpose,effective,effective_reason,observed,expires,subject,age,territory,proxy,sha,now());
 SELECT e.observed_at INTO current_observed FROM race_private.compliance_current c JOIN race_private.compliance_receipts e ON(e.tenant_id,e.id)=(c.tenant_id,c.receipt_id) WHERE c.tenant_id=t AND c.user_id=u AND c.purpose=grid_record_compliance.purpose;
 IF current_observed IS NULL OR observed>current_observed THEN
  INSERT INTO race_private.compliance_current VALUES(t,u,purpose,receipt) ON CONFLICT ON CONSTRAINT compliance_current_pkey DO UPDATE SET receipt_id=excluded.receipt_id;
 END IF;
 IF effective='review' OR(purpose='risk' AND effective='denied') THEN INSERT INTO race_private.risk_cases VALUES(t,gen_random_uuid(),u,receipt,effective_reason,now());END IF;
 RETURN jsonb_build_object('receipt_id',receipt,'decision',effective,'duplicate',false,'current',current_observed IS NULL OR observed>current_observed);
END $$;
CREATE FUNCTION race_private.grid_resolve_review(t uuid,provider uuid,case_ref uuid,reason text,sha text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c race_private.risk_cases%ROWTYPE;r race_private.risk_resolutions%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=provider AND enabled) OR reason IS NULL OR length(reason) NOT BETWEEN 10 AND 500 OR sha IS NULL OR sha!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_review_resolution' USING ERRCODE='PT403'; END IF;
 SELECT * INTO c FROM race_private.risk_cases WHERE tenant_id=t AND id=case_ref;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_not_found' USING ERRCODE='PT404'; END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=c.user_id FOR NO KEY UPDATE;
 SELECT * INTO r FROM race_private.risk_resolutions WHERE tenant_id=t AND case_id=case_ref;
 IF FOUND THEN IF(r.provider_id,r.reason,r.payload_sha256) IS DISTINCT FROM(provider,reason,sha) THEN RAISE EXCEPTION 'review_resolution_conflict' USING ERRCODE='PT409'; END IF;
 RETURN jsonb_build_object('resolved',true,'duplicate',true); END IF;
 INSERT INTO race_private.risk_resolutions VALUES(t,case_ref,provider,reason,sha,now());
 RETURN jsonb_build_object('resolved',true,'duplicate',false);
END $$;
CREATE FUNCTION race_private.grid_consent(t uuid,program uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u uuid:=race_private.customer_wallet(t);p jsonb;
BEGIN
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=u FOR NO KEY UPDATE;
 PERFORM program_id FROM race_private.program_activations WHERE tenant_id=t FOR SHARE;
 p:=race_private.grid_program(t);
 IF p IS NULL OR (p->>'id')::uuid IS DISTINCT FROM program THEN RAISE EXCEPTION 'program_version_unavailable' USING ERRCODE='PT409'; END IF;
 INSERT INTO race_private.program_consents(tenant_id,user_id,program_id) VALUES(t,u,program) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('program_id',program,'consent_recorded',true);
END $$;
CREATE FUNCTION race_private.grid_compliance(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u uuid:=race_private.customer_wallet(t);r jsonb;p jsonb;period timestamptz;remaining integer;
BEGIN r:=race_private.grid_eligibility(t,u);
 p:=r->'program';
 IF p->>'id' IS NOT NULL THEN
  period:=(p->>'starts_at')::timestamptz+make_interval(secs=>floor(extract(epoch FROM(clock_timestamp()-(p->>'starts_at')::timestamptz))/((p->>'period_hours')::integer*3600))*((p->>'period_hours')::integer*3600));
  SELECT greatest(0,(p->>'entries_per_period')::integer-count(*)) INTO remaining FROM race_private.ame_requests WHERE tenant_id=t AND user_id=u AND program_id=(p->>'id')::uuid AND period_start=period AND state='Credited';
 END IF;
 RETURN r||jsonb_build_object('entries_remaining',remaining,'next_period_at',period+make_interval(hours=>(p->>'period_hours')::integer),'requests',coalesce((SELECT jsonb_agg(row_to_json(q)) FROM(SELECT id,program_id,state,reason,amount::text,period_start,journal_id,created_at FROM race_private.ame_requests WHERE tenant_id=t AND user_id=u ORDER BY created_at DESC,id LIMIT 50)q),'[]'::jsonb));
END $$;
CREATE FUNCTION race_private.grid_ame(t uuid,request uuid,program uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid:=race_private.customer_wallet(t);p race_private.promotion_programs%ROWTYPE;r race_private.ame_requests%ROWTYPE;e jsonb;period timestamptz;why text;tx jsonb;
BEGIN
 IF request IS NULL OR program IS NULL THEN RAISE EXCEPTION 'invalid_free_entry' USING ERRCODE='PT400'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ame:'||t::text||request::text,0));
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=u FOR NO KEY UPDATE;
 SELECT * INTO r FROM race_private.ame_requests WHERE tenant_id=t AND id=request;
 IF FOUND THEN IF(r.user_id,r.program_id) IS DISTINCT FROM(u,program) THEN RAISE EXCEPTION 'ame_idempotency_conflict' USING ERRCODE='PT409'; END IF;
 RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text,'duplicate',true); END IF;
 IF(SELECT count(*) FROM race_private.ame_requests WHERE tenant_id=t AND user_id=u AND created_at>clock_timestamp()-interval '1 minute')>=20 THEN RAISE EXCEPTION 'free_entry_velocity_limit' USING ERRCODE='PT429';END IF;
 SELECT * INTO p FROM race_private.promotion_programs WHERE tenant_id=t AND id=program;
 IF NOT FOUND THEN RAISE EXCEPTION 'program_not_found' USING ERRCODE='PT404'; END IF;
 PERFORM program_id FROM race_private.program_activations WHERE tenant_id=t FOR SHARE;
 e:=race_private.grid_eligibility(t,u);
 period:=p.starts_at+make_interval(secs=>floor(extract(epoch FROM(clock_timestamp()-p.starts_at))/(p.period_hours*3600))*(p.period_hours*3600));
 why:=CASE WHEN e->'program'->>'id' IS DISTINCT FROM program::text THEN 'program_unavailable'
  WHEN(e->>'eligible')::boolean IS DISTINCT FROM true THEN e->>'reason'
  WHEN EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=t AND user_id=u AND(payment_review OR pause_until>clock_timestamp())) THEN 'account_or_participation_unavailable'
  WHEN(SELECT count(*) FROM race_private.ame_requests WHERE tenant_id=t AND user_id=u AND program_id=program AND period_start=period AND state='Credited')>=p.entries_per_period THEN 'period_limit_reached' ELSE NULL END;
 IF why IS NULL THEN tx:=race_private.credit_wallet(t,u,'SC',p.free_sc,'ame:'||request::text);END IF;
 INSERT INTO race_private.ame_requests(tenant_id,id,user_id,program_id,period_start,state,reason,amount,identity_receipt,location_receipt,journal_id)
 VALUES(t,request,u,program,period,CASE WHEN why IS NULL THEN 'Credited' ELSE 'Rejected' END,coalesce(why,'free_entry_confirmed'),CASE WHEN why IS NULL THEN p.free_sc ELSE 0 END,
  (e->>'identity_receipt')::uuid,(e->>'location_receipt')::uuid,(tx->>'transaction_id')::uuid) RETURNING * INTO r;
 RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text,'duplicate',false,'next_period_at',period+make_interval(hours=>p.period_hours));
END $$;
CREATE FUNCTION race_private.grid_request_budget(t uuid,operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a uuid:=race_private.customer_identity();w timestamptz:=date_trunc('minute',clock_timestamp());n integer;cap integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.tenants WHERE id=t AND enabled AND customer_signup_enabled) THEN RAISE EXCEPTION 'tenant_unavailable' USING ERRCODE='PT403'; END IF;
 cap:=CASE operation WHEN 'read' THEN 60 WHEN 'mutate' THEN 20 WHEN 'checkout' THEN 5 WHEN 'identity' THEN 5 ELSE NULL END;
 IF cap IS NULL THEN RAISE EXCEPTION 'invalid_budget' USING ERRCODE='PT400'; END IF;
 INSERT INTO race_private.request_budgets VALUES(t,a,operation,w,1) ON CONFLICT ON CONSTRAINT request_budgets_pkey DO UPDATE SET used=least(race_private.request_budgets.used+1,1000000) RETURNING used INTO n;
 RETURN jsonb_build_object('allowed',n<=cap,'retry_after',greatest(1,ceil(extract(epoch FROM(w+interval '1 minute'-clock_timestamp()))))::integer);
END $$;
CREATE FUNCTION race_private.grid_funding_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u uuid;count_active integer;count_recent integer;
BEGIN
 FOR u IN SELECT id FROM race_private.users WHERE tenant_id=NEW.tenant_id AND id IN(NEW.challenger_id,NEW.opponent_id) ORDER BY id FOR NO KEY UPDATE LOOP
  IF EXISTS(SELECT 1 FROM race_private.profiles WHERE tenant_id=NEW.tenant_id AND user_id=u) THEN PERFORM race_private.customer_can_play(NEW.tenant_id,u,NEW.token_type::text);
  ELSIF NEW.token_type='SC' THEN RAISE EXCEPTION 'verified_profile_required' USING ERRCODE='PT403'; END IF;
  SELECT count(*) FILTER(WHERE remaining_escrow>0),count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 minute') INTO count_active,count_recent
   FROM race_private.challenges WHERE tenant_id=NEW.tenant_id AND u IN(challenger_id,opponent_id);
  IF count_active>=20 OR count_recent>=10 THEN RAISE EXCEPTION 'challenge_velocity_limit' USING ERRCODE='PT429'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER funding_guard BEFORE INSERT ON race_private.challenges FOR EACH ROW EXECUTE FUNCTION race_private.grid_funding_guard();
CREATE FUNCTION race_private.grid_offer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM id FROM race_private.users WHERE tenant_id=NEW.tenant_id AND id=NEW.creator_id FOR NO KEY UPDATE;
 IF(SELECT count(*) FROM race_private.sim_offers o JOIN race_private.sim_events e ON(e.tenant_id,e.id)=(o.tenant_id,o.event_id)
  WHERE o.tenant_id=NEW.tenant_id AND o.creator_id=NEW.creator_id AND o.state='Open' AND e.funding_closes_at>clock_timestamp())>=20 THEN RAISE EXCEPTION 'open_invitation_limit' USING ERRCODE='PT429'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offer_guard BEFORE INSERT ON race_private.sim_offers FOR EACH ROW EXECUTE FUNCTION race_private.grid_offer_guard();

CREATE FUNCTION race_private.grid_journal_payload(t uuid,tx uuid) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',1,'tenant_id',j.tenant_id,'transaction_id',j.id,'token_type',j.token_type,'kind',j.kind,'challenge_id',j.challenge_id,'external_ref',j.external_ref,'created_at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'lines',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'bucket',l.bucket,'user_id',l.user_id,'delta',l.delta::text) ORDER BY l.id) FROM race_private.journal_lines l WHERE(l.tenant_id,l.transaction_id)=(j.tenant_id,j.id))) FROM race_private.journal_transactions j WHERE j.tenant_id=t AND j.id=tx
$$;
CREATE FUNCTION race_private.grid_seal_journal(t uuid,tx uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE payload jsonb;wallet uuid;head race_private.audit_heads%ROWTYPE;record_payload jsonb;digest text;
BEGIN
 IF EXISTS(SELECT 1 FROM race_private.journal_seals WHERE tenant_id=t AND transaction_id=tx) THEN RETURN;END IF;
 IF(SELECT count(*)<2 OR sum(delta)<>0 FROM race_private.journal_lines WHERE tenant_id=t AND transaction_id=tx) IS DISTINCT FROM false THEN RAISE EXCEPTION 'unbalanced_journal' USING ERRCODE='23514'; END IF;
 payload:=race_private.grid_journal_payload(t,tx);
 INSERT INTO race_private.journal_seals VALUES(t,tx,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex'));
 FOR wallet IN SELECT DISTINCT user_id FROM race_private.journal_lines WHERE tenant_id=t AND transaction_id=tx AND user_id IS NOT NULL ORDER BY user_id LOOP
  INSERT INTO race_private.audit_heads(tenant_id,user_id) VALUES(t,wallet) ON CONFLICT DO NOTHING;
  SELECT * INTO head FROM race_private.audit_heads WHERE tenant_id=t AND user_id=wallet FOR UPDATE;
  record_payload:=jsonb_build_object('tenant_id',t,'user_id',wallet,'sequence',(head.sequence+1)::text,'journal',payload);
  digest:=encode(sha256(convert_to(head.hash||E'\n'||record_payload::text,'UTF8')),'hex');
  INSERT INTO race_private.audit_records VALUES(t,wallet,head.sequence+1,tx,head.hash,digest,record_payload);
  UPDATE race_private.audit_heads SET sequence=head.sequence+1,hash=digest WHERE tenant_id=t AND user_id=wallet;
 END LOOP;
END $$;
CREATE FUNCTION race_private.grid_seal_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM race_private.grid_seal_journal(NEW.tenant_id,NEW.id);RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER zz_seal_journal AFTER INSERT ON race_private.journal_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION race_private.grid_seal_trigger();
CREATE FUNCTION race_private.grid_reject_sealed_line() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN IF EXISTS(SELECT 1 FROM race_private.journal_seals WHERE tenant_id=NEW.tenant_id AND transaction_id=NEW.transaction_id) THEN RAISE EXCEPTION 'sealed_journal' USING ERRCODE='PT409';END IF;RETURN NEW;END $$;
CREATE TRIGGER sealed_lines BEFORE INSERT ON race_private.journal_lines FOR EACH ROW EXECUTE FUNCTION race_private.grid_reject_sealed_line();
-- Backfill historical journals deterministically during the locked migration.
LOCK TABLE race_private.journal_transactions,race_private.journal_lines IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE j record; BEGIN FOR j IN SELECT tenant_id,id FROM race_private.journal_transactions ORDER BY created_at,id LOOP PERFORM race_private.grid_seal_journal(j.tenant_id,j.id);END LOOP;END $$;
CREATE FUNCTION race_private.grid_audit_export(t uuid,u uuid,after_sequence bigint,until_sequence bigint) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('tenant_id',t,'user_id',u,'head',(SELECT jsonb_build_object('sequence',sequence::text,'hash',hash) FROM race_private.audit_heads WHERE tenant_id=t AND user_id=u),
 'records',coalesce((SELECT jsonb_agg(row_to_json(r)) FROM(SELECT sequence::text,transaction_id,previous_hash,hash,payload::text AS canonical_payload FROM race_private.audit_records WHERE tenant_id=t AND user_id=u AND sequence>greatest(after_sequence,0) AND(until_sequence IS NULL OR sequence<=until_sequence) ORDER BY sequence LIMIT 100)r),'[]'::jsonb))
$$;
CREATE FUNCTION race_private.grid_wallet_audit(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u uuid:=race_private.customer_wallet(t);
BEGIN RETURN coalesce((SELECT jsonb_build_object('sequence',sequence::text,'hash',hash) FROM race_private.audit_heads WHERE tenant_id=t AND user_id=u),jsonb_build_object('sequence','0','hash',repeat('0',64)));END $$;
CREATE FUNCTION race_private.grid_touch_wallet() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.updated_at:=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER touch_wallet BEFORE UPDATE ON race_private.users FOR EACH ROW EXECUTE FUNCTION race_private.grid_touch_wallet();

DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('race_private.sim_offer_internal(uuid,uuid,uuid,uuid,text,text,text,text,uuid)'::regprocedure);
 definition:=replace(definition,'''duplicate'',true);','''duplicate'',true,''track_name'',e.track_name,''event_title'',e.title);');
 definition:=replace(definition,'''duplicate'',false);','''duplicate'',false,''track_name'',e.track_name,''event_title'',e.title);');
 EXECUTE definition;
END $$;
CREATE FUNCTION public.grid_program(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT jsonb_build_object('program',race_private.grid_program(p_tenant_id))$$;
CREATE FUNCTION public.grid_publish_program(p_tenant_id uuid,p_provider_id uuid,p_change_id uuid,p_program_id uuid,p_version text,p_title text,p_sponsor text,p_official_rules_url text,p_rules_sha256 text,p_starts_at timestamptz,p_ends_at timestamptz,p_minimum_age integer,p_territories jsonb,p_free_sc numeric,p_period_hours integer,p_entries_per_period integer,p_authorization_reference text,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_publish_program(p_tenant_id,p_provider_id,p_change_id,p_program_id,p_version,p_title,p_sponsor,p_official_rules_url,p_rules_sha256,p_starts_at,p_ends_at,p_minimum_age,p_territories,p_free_sc,p_period_hours,p_entries_per_period,p_authorization_reference,p_payload_sha256)$$;
CREATE FUNCTION public.grid_activate_program(p_tenant_id uuid,p_provider_id uuid,p_change_id uuid,p_program_id uuid,p_enabled boolean,p_authorization_reference text,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_activate_program(p_tenant_id,p_provider_id,p_change_id,p_program_id,p_enabled,p_authorization_reference,p_payload_sha256)$$;
CREATE FUNCTION public.grid_install_catalog(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_install_catalog(p_tenant_id)$$;
CREATE FUNCTION public.grid_register_event(p_tenant_id uuid,p_provider_id uuid,p_event_id uuid,p_game text,p_external_session_id text,p_title text,p_track_name text,p_starts_at timestamptz,p_funding_closes_at timestamptz,p_deadline timestamptz,p_rule text,p_entrants jsonb,p_min_lap_seconds numeric,p_max_lap_seconds numeric) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_register_event(p_tenant_id,p_provider_id,p_event_id,p_game,p_external_session_id,p_title,p_track_name,p_starts_at,p_funding_closes_at,p_deadline,p_rule,p_entrants,p_min_lap_seconds,p_max_lap_seconds)$$;
CREATE FUNCTION public.grid_cleanup_budgets() RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_cleanup_budgets()$$;
CREATE FUNCTION public.grid_compliance(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_compliance(p_tenant_id)$$;
CREATE FUNCTION public.grid_consent(p_tenant_id uuid,p_program_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_consent(p_tenant_id,p_program_id)$$;
CREATE FUNCTION public.grid_ame(p_tenant_id uuid,p_request_id uuid,p_program_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_ame(p_tenant_id,p_request_id,p_program_id)$$;
CREATE FUNCTION public.grid_request_budget(p_tenant_id uuid,p_operation text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_request_budget(p_tenant_id,p_operation)$$;
CREATE FUNCTION public.grid_wallet_audit(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_wallet_audit(p_tenant_id)$$;
CREATE FUNCTION public.grid_record_compliance(p_tenant_id uuid,p_provider_id uuid,p_receipt_id uuid,p_auth_user_id uuid,p_purpose text,p_decision text,p_reason text,p_observed_at timestamptz,p_valid_until timestamptz,p_subject_key text,p_age_threshold integer,p_territory text,p_proxy_detected boolean,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_record_compliance(p_tenant_id,p_provider_id,p_receipt_id,p_auth_user_id,p_purpose,p_decision,p_reason,p_observed_at,p_valid_until,p_subject_key,p_age_threshold,p_territory,p_proxy_detected,p_payload_sha256)$$;
CREATE FUNCTION public.grid_resolve_review(p_tenant_id uuid,p_provider_id uuid,p_case_id uuid,p_reason text,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_resolve_review(p_tenant_id,p_provider_id,p_case_id,p_reason,p_payload_sha256)$$;
CREATE FUNCTION public.grid_audit_export(p_tenant_id uuid,p_user_id uuid,p_after_sequence bigint DEFAULT 0,p_until_sequence bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.grid_audit_export(p_tenant_id,p_user_id,p_after_sequence,p_until_sequence)$$;

DO $$ DECLARE f record; roles text; private_name text; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS sig,p.proname,n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','race_private') AND p.proname LIKE 'grid_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  roles:=CASE WHEN f.proname='grid_program' THEN 'anon,authenticated,service_role'
   WHEN f.proname IN('grid_compliance','grid_consent','grid_ame','grid_request_budget','grid_wallet_audit') THEN 'authenticated'
   WHEN f.proname IN('grid_record_compliance','grid_resolve_review','grid_audit_export','grid_publish_program','grid_activate_program','grid_install_catalog','grid_register_event','grid_cleanup_budgets') THEN 'service_role' ELSE NULL END;
  IF roles IS NOT NULL THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s',f.sig,roles);END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA race_private TO anon;
CREATE FUNCTION race_private.execute_p2p_escrow(p_challenge_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE actor uuid:=race_private.customer_identity();t uuid;n integer;
BEGIN
 SELECT count(*),min(o.tenant_id::text)::uuid INTO n,t FROM race_private.sim_offers o JOIN race_private.users u ON u.tenant_id=o.tenant_id AND u.auth_user_id=actor
 WHERE o.id=p_challenge_id AND o.mode='driver_duel' AND o.creator_id<>u.id AND(o.target_id IS NULL OR o.target_id=u.id);
 IF n<>1 THEN RAISE EXCEPTION 'challenge_unavailable_or_ambiguous' USING ERRCODE='PT403'; END IF;
 RETURN race_private.sim_accept_internal(t,race_private.customer_wallet(t),p_challenge_id,true,NULL);
END $$;
CREATE FUNCTION public.execute_p2p_escrow(p_challenge_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.execute_p2p_escrow(p_challenge_id)$$;

CREATE FUNCTION race_private.commit_challenge_settlement(t uuid,p_challenge_id uuid,p_winner_id uuid,p_payout_amount numeric,p_token_type text,p_subsession text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c race_private.challenges%ROWTYPE;v race_private.provider_evidence%ROWTYPE;e race_private.sim_events%ROWTYPE;a numeric;b numeric;outcome text;winner uuid;amount numeric;
BEGIN
 SELECT * INTO c FROM race_private.challenges WHERE tenant_id=t AND id=p_challenge_id FOR UPDATE;
 SELECT * INTO v FROM race_private.provider_evidence WHERE tenant_id=t AND challenge_id=p_challenge_id;
 SELECT event.* INTO e FROM race_private.sim_contracts s JOIN race_private.sim_events event ON(event.tenant_id,event.id)=(s.tenant_id,s.event_id) WHERE s.tenant_id=t AND s.challenge_id=p_challenge_id;
 IF c.id IS NULL OR v.challenge_id IS NULL OR e.id IS NULL OR e.external_session_id IS DISTINCT FROM p_subsession
  OR NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=c.provider_id AND enabled) THEN RAISE EXCEPTION 'authoritative_evidence_required' USING ERRCODE='PT403'; END IF;
 a:=(v.summary->>'best_a')::numeric;b:=(v.summary->>'best_b')::numeric;
 outcome:=CASE WHEN v.summary->>'resolution'='network_drop' THEN 'network_drop' WHEN a IS NULL AND b IS NULL THEN 'no_clean_laps' WHEN a=b THEN 'tie' ELSE 'winner' END;
 IF v.summary->>'resolution' IS DISTINCT FROM outcome THEN RAISE EXCEPTION 'evidence_decision_mismatch' USING ERRCODE='PT409'; END IF;
 IF outcome='winner' THEN winner:=CASE WHEN b IS NULL OR(a IS NOT NULL AND a<b) THEN c.challenger_id ELSE c.opponent_id END; END IF;
 amount:=CASE WHEN outcome='winner' THEN c.prize_pool ELSE 0 END;
 IF(p_winner_id,p_payout_amount,p_token_type) IS DISTINCT FROM(winner,amount,c.token_type::text) THEN RAISE EXCEPTION 'settlement_terms_mismatch' USING ERRCODE='PT409'; END IF;
 RETURN race_private.finish_challenge(t,c.id,c.provider_id,'sim:'||v.source_id,v.sha256,outcome::race_private.resolution,winner,a,b);
END $$;
CREATE FUNCTION race_private.commit_challenge_settlement(p_challenge_id uuid,p_winner_id uuid,p_payout_amount numeric,p_token_type text,p_subsession text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid;n integer;
BEGIN SELECT count(*),min(tenant_id::text)::uuid INTO n,t FROM race_private.challenges WHERE id=p_challenge_id;
 IF n<>1 THEN RAISE EXCEPTION 'challenge_unavailable_or_ambiguous' USING ERRCODE='PT404'; END IF;
 RETURN race_private.commit_challenge_settlement(t,p_challenge_id,p_winner_id,p_payout_amount,p_token_type,p_subsession);
END $$;
CREATE FUNCTION public.commit_challenge_settlement(p_challenge_id uuid,p_winner_id uuid,p_payout_amount numeric,p_token_type text,p_subsession text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.commit_challenge_settlement(p_challenge_id,p_winner_id,p_payout_amount,p_token_type,p_subsession)$$;
-- Authoritative evidence and the posting are in the SAME RPC transaction. The
-- compatibility settlement RPC can never choose a winner or amount independently.
DO $$ DECLARE definition text; original text; replacement text; BEGIN
 definition:=pg_get_functiondef('public.sim_commit_result(uuid,uuid,uuid,text,text,text,timestamptz,text,text,numeric,numeric,jsonb)'::regprocedure);
 original:=$old$r:=race_private.finish_challenge(p_tenant_id,c.id,c.provider_id,'sim:'||p_source_id,p_payload_sha256,resolution::race_private.resolution,win,p_best_a,p_best_b);
 INSERT INTO race_private.provider_evidence VALUES(p_tenant_id,p_challenge_id,p_source_id,p_payload_sha256,p_summary,now());$old$;
 replacement:=$new$IF e.rule='fastest_clean_lap' AND((p_best_a IS NOT NULL AND(p_best_a<e.min_lap_seconds OR p_best_a>e.max_lap_seconds)) OR(p_best_b IS NOT NULL AND(p_best_b<e.min_lap_seconds OR p_best_b>e.max_lap_seconds))) THEN RAISE EXCEPTION 'lap_outside_registered_bounds' USING ERRCODE='PT400';END IF;
 INSERT INTO race_private.provider_evidence VALUES(p_tenant_id,p_challenge_id,p_source_id,p_payload_sha256,p_summary||jsonb_build_object('resolution',resolution,'best_a',p_best_a::text,'best_b',p_best_b::text,'actual_start',p_actual_start),now());
 r:=race_private.commit_challenge_settlement(p_tenant_id,c.id,win,CASE WHEN resolution='winner' THEN c.prize_pool ELSE 0 END,c.token_type::text,e.external_session_id);$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unexpected_source_function_definition'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION public.execute_p2p_escrow(uuid),race_private.execute_p2p_escrow(uuid),public.commit_challenge_settlement(uuid,uuid,numeric,text,text),race_private.commit_challenge_settlement(uuid,uuid,numeric,text,text),race_private.commit_challenge_settlement(uuid,uuid,uuid,numeric,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.execute_p2p_escrow(uuid),race_private.execute_p2p_escrow(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_challenge_settlement(uuid,uuid,numeric,text,text),race_private.commit_challenge_settlement(uuid,uuid,numeric,text,text) TO service_role;
DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('race_private.customer_state(uuid)'::regprocedure);
 definition:=replace(definition,'p.sc_eligible AND t.sc_enabled',$new$coalesce((race_private.grid_eligibility(p_tenant_id,wallet)->>'eligible')::boolean,false)$new$);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.sim_result_context(uuid,uuid)'::regprocedure);
 definition:=replace(definition,$old$'track_name',e.track_name$old$,$new$'track_name',e.track_name,'min_lap_seconds',e.min_lap_seconds::text,'max_lap_seconds',e.max_lap_seconds::text$new$);
 EXECUTE definition;
END $$;
CREATE FUNCTION race_private.grid_wallet_topic_allowed(topic text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parts text[]:=string_to_array(topic,':');actor uuid;t uuid;
BEGIN
 IF cardinality(parts)<>3 OR parts[1]<>'gridstake-wallet' THEN RETURN false;END IF;
 actor:=race_private.customer_identity();t:=parts[2]::uuid;
 RETURN parts[3]=actor::text AND EXISTS(SELECT 1 FROM race_private.users u JOIN race_private.tenants x ON x.id=u.tenant_id WHERE u.tenant_id=t AND u.auth_user_id=actor AND u.enabled AND x.enabled AND x.customer_signup_enabled);
EXCEPTION WHEN invalid_text_representation OR SQLSTATE 'PT403' THEN RETURN false;
END $$;
CREATE FUNCTION race_private.grid_wallet_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.auth_user_id IS NOT NULL AND to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL THEN
  PERFORM realtime.send(jsonb_build_object('refresh',true),'wallet_changed','gridstake-wallet:'||NEW.tenant_id::text||':'||NEW.auth_user_id::text,true);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER wallet_invalidations AFTER INSERT OR UPDATE OF gc_balance,sc_balance,enabled ON race_private.users FOR EACH ROW EXECUTE FUNCTION race_private.grid_wallet_invalidate();
REVOKE ALL ON FUNCTION race_private.grid_wallet_topic_allowed(text),race_private.grid_wallet_invalidate() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION race_private.grid_wallet_topic_allowed(text) TO authenticated;
DO $$ BEGIN
 IF to_regclass('realtime.messages') IS NOT NULL AND to_regprocedure('realtime.topic()') IS NOT NULL THEN
  CREATE POLICY gridstake_wallet_receive ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND race_private.grid_wallet_topic_allowed(topic));
  CREATE POLICY gridstake_wallet_isolation ON realtime.messages AS RESTRICTIVE FOR SELECT TO authenticated USING(topic NOT LIKE 'gridstake-wallet:%' OR(topic=(SELECT realtime.topic()) AND race_private.grid_wallet_topic_allowed(topic)));
  CREATE POLICY gridstake_wallet_no_client_publish ON realtime.messages AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(topic NOT LIKE 'gridstake-wallet:%');
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
