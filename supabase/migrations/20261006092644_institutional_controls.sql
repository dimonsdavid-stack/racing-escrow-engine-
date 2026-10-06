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
