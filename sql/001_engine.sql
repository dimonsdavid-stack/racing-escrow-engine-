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
