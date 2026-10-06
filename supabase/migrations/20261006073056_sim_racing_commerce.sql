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
CREATE FUNCTION public.sim_commit_result(p_tenant_id uuid,p_provider_id uuid,p_challenge_id uuid,p_source_id text,p_external_session_id text,p_track_name text,p_actual_start timestamptz,p_payload_sha256 text,p_resolution text,p_best_a numeric,p_best_b numeric,p_summary jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c race_private.challenges%ROWTYPE;s race_private.sim_contracts%ROWTYPE;e race_private.sim_events%ROWTYPE;win uuid;resolution text;r jsonb;v race_private.provider_evidence%ROWTYPE;
BEGIN SELECT * INTO c FROM race_private.challenges WHERE tenant_id=p_tenant_id AND id=p_challenge_id FOR UPDATE;
 SELECT * INTO s FROM race_private.sim_contracts WHERE tenant_id=p_tenant_id AND challenge_id=p_challenge_id;
 SELECT * INTO e FROM race_private.sim_events WHERE tenant_id=p_tenant_id AND id=s.event_id;
 IF c.id IS NULL OR s.challenge_id IS NULL OR (c.provider_id,e.external_session_id,e.track_name) IS DISTINCT FROM(p_provider_id,p_external_session_id,p_track_name) THEN RAISE EXCEPTION 'source_binding_mismatch' USING ERRCODE='PT403'; END IF;
 IF p_actual_start IS NULL OR p_actual_start<=s.funded_at OR abs(extract(epoch FROM(p_actual_start-e.starts_at)))>300 THEN RAISE EXCEPTION 'historical_or_wrong_session' USING ERRCODE='PT403'; END IF;
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
