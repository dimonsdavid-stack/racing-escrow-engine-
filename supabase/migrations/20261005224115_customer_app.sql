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
