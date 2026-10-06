-- Enum additions must commit before new labels can be used (PostgreSQL 15+).
BEGIN;
ALTER TYPE race_private.bucket ADD VALUE IF NOT EXISTS 'Redemption';
ALTER TYPE race_private.bucket ADD VALUE IF NOT EXISTS 'Disbursement';
COMMIT;
BEGIN;
CREATE TYPE race_private.kyc_status AS ENUM ('Unverified','Pending','Verified');
ALTER TABLE race_private.users ADD COLUMN kyc_status race_private.kyc_status NOT NULL DEFAULT 'Unverified', ADD COLUMN kyc_reference_id text, ADD COLUMN kyc_checked_at timestamptz;
ALTER TABLE race_private.users ADD COLUMN sc_redeemable_balance numeric(24,6) NOT NULL DEFAULT 0 CHECK(sc_redeemable_balance>=0 AND sc_redeemable_balance<=sc_balance);
ALTER TABLE race_private.challenges ADD COLUMN challenger_redeemable_entry numeric(24,6) NOT NULL DEFAULT 0,ADD COLUMN opponent_redeemable_entry numeric(24,6) NOT NULL DEFAULT 0;
-- Existing balances are classified from the immutable per-wallet journal order,
-- not from a blanket opening grant. Refunded entries retain their classification.
DO $$DECLARE w record;l record;eligible numeric;spent numeric;BEGIN
 LOCK TABLE race_private.users,race_private.challenges,race_private.journal_transactions,race_private.journal_lines IN SHARE ROW EXCLUSIVE MODE;
 FOR w IN SELECT tenant_id,id,sc_balance FROM race_private.users ORDER BY tenant_id,id LOOP
  eligible:=0;
  FOR l IN SELECT j.kind,j.challenge_id,x.delta FROM race_private.audit_records a JOIN race_private.journal_transactions j ON(j.tenant_id,j.id)=(a.tenant_id,a.transaction_id) JOIN race_private.journal_lines x ON(x.tenant_id,x.transaction_id,x.user_id)=(a.tenant_id,a.transaction_id,a.user_id) WHERE a.tenant_id=w.tenant_id AND a.user_id=w.id AND j.token_type='SC' ORDER BY a.sequence LOOP
   IF l.kind='fund' THEN spent:=least(eligible,-l.delta);eligible:=eligible-spent;
    UPDATE race_private.challenges SET challenger_redeemable_entry=CASE WHEN challenger_id=w.id THEN spent ELSE challenger_redeemable_entry END,opponent_redeemable_entry=CASE WHEN opponent_id=w.id THEN spent ELSE opponent_redeemable_entry END WHERE tenant_id=w.tenant_id AND id=l.challenge_id;
   ELSIF l.kind='settle' THEN eligible:=eligible+l.delta;
   ELSIF l.kind='refund' THEN eligible:=eligible+(SELECT CASE WHEN challenger_id=w.id THEN challenger_redeemable_entry ELSE opponent_redeemable_entry END FROM race_private.challenges WHERE tenant_id=w.tenant_id AND id=l.challenge_id);
   END IF;
  END LOOP;
  IF eligible>w.sc_balance THEN RAISE EXCEPTION 'historical_wallet_reconciliation_failed';END IF;
  UPDATE race_private.users SET sc_redeemable_balance=eligible WHERE tenant_id=w.tenant_id AND id=w.id;
 END LOOP;
END $$;
DO $$DECLARE d text;old text;BEGIN
 d:=pg_get_functiondef('race_private.create_and_lock_challenge(uuid,uuid,uuid,uuid,text,numeric,uuid,uuid,timestamptz)'::regprocedure);
 old:=$o$  UPDATE race_private.users SET
    gc_balance = gc_balance -$o$;
 IF position(old IN d)=0 THEN RAISE EXCEPTION 'funding_definition_mismatch';END IF;
 d:=replace(d,old,$n$  UPDATE race_private.challenges SET
    challenger_redeemable_entry=CASE WHEN p_token_type='SC' THEN(SELECT least(sc_redeemable_balance,p_entry_fee) FROM race_private.users WHERE tenant_id=p_tenant_id AND id=p_challenger_id) ELSE 0 END,
    opponent_redeemable_entry=CASE WHEN p_token_type='SC' THEN(SELECT least(sc_redeemable_balance,p_entry_fee) FROM race_private.users WHERE tenant_id=p_tenant_id AND id=p_opponent_id) ELSE 0 END
    WHERE tenant_id=p_tenant_id AND id=c.id;
  UPDATE race_private.users SET
    sc_redeemable_balance=sc_redeemable_balance-CASE WHEN p_token_type='SC' THEN least(sc_redeemable_balance,p_entry_fee) ELSE 0 END,
    gc_balance = gc_balance -$n$);EXECUTE d;
 d:=pg_get_functiondef('race_private.finish_challenge(uuid,uuid,uuid,text,text,race_private.resolution,uuid,numeric,numeric,boolean)'::regprocedure);
 old:=$o$sc_balance = sc_balance + CASE WHEN c.token_type = 'SC' THEN v_payout ELSE 0 END$o$;
 IF position(old IN d)=0 THEN RAISE EXCEPTION 'settlement_definition_mismatch';END IF;
 d:=replace(d,old,old||$n$, sc_redeemable_balance=sc_redeemable_balance+CASE WHEN c.token_type='SC' THEN v_payout ELSE 0 END$n$);
 old:=$o$sc_balance = sc_balance + CASE WHEN c.token_type = 'SC' THEN c.entry_fee ELSE 0 END$o$;
 IF position(old IN d)=0 THEN RAISE EXCEPTION 'refund_definition_mismatch';END IF;
 d:=replace(d,old,old||$n$, sc_redeemable_balance=sc_redeemable_balance+CASE WHEN c.token_type='SC' THEN CASE WHEN id=c.challenger_id THEN c.challenger_redeemable_entry ELSE c.opponent_redeemable_entry END ELSE 0 END$n$);EXECUTE d;
END $$;
CREATE TABLE race_private.kyc_receipts (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,id text NOT NULL,applicant_id text NOT NULL,status race_private.kyc_status NOT NULL,observed_at timestamptz NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id));
CREATE UNIQUE INDEX kyc_subject_owner ON race_private.users(tenant_id,kyc_reference_id) WHERE kyc_reference_id IS NOT NULL;
CREATE TABLE race_private.payout_accounts (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,intent_id uuid NOT NULL DEFAULT gen_random_uuid(),started_at timestamptz NOT NULL DEFAULT clock_timestamp(),account_id text UNIQUE,bank_id text,ready_until timestamptz,
 PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),CHECK(account_id IS NULL OR account_id~'^acct_[A-Za-z0-9]+$'),CHECK(bank_id IS NULL OR bank_id~'^ba_[A-Za-z0-9]+$'));
CREATE TABLE race_private.redemptions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,amount_sc numeric(24,6) NOT NULL CHECK(amount_sc>=50 AND amount_sc<=10000 AND amount_sc=round(amount_sc,2)),amount_cents integer GENERATED ALWAYS AS((amount_sc*100)::integer) STORED,
 account_id text NOT NULL,bank_id text NOT NULL,program_id uuid NOT NULL,state text NOT NULL DEFAULT 'Reserved' CHECK(state IN('Reserved','Transferred','PayoutPending','Paid','Reversing','Returned','Review')),
 transfer_id text UNIQUE,payout_id text UNIQUE,transfer_started_at timestamptz,payout_started_at timestamptz,reversal_started_at timestamptz,lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id));
CREATE INDEX redemption_work_queue ON race_private.redemptions(next_attempt_at,created_at) WHERE state NOT IN('Returned','Review');
CREATE TABLE race_private.redemption_receipts (
 tenant_id uuid NOT NULL,redemption_id uuid NOT NULL,id text NOT NULL,phase text NOT NULL,provider_id text NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,redemption_id) REFERENCES race_private.redemptions(tenant_id,id));
CREATE TABLE race_private.redemption_tax_events (
 tenant_id uuid NOT NULL,redemption_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('Paid','Returned')),amount_usd numeric(24,6) NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,redemption_id,kind),FOREIGN KEY(tenant_id,redemption_id) REFERENCES race_private.redemptions(tenant_id,id));
ALTER TABLE race_private.journal_transactions DROP CONSTRAINT journal_transactions_kind_check, DROP CONSTRAINT journal_transactions_check;
ALTER TABLE race_private.journal_transactions ADD COLUMN redemption_id uuid, ADD FOREIGN KEY(tenant_id,redemption_id) REFERENCES race_private.redemptions(tenant_id,id),
 ADD CHECK(kind IN('fund','settle','refund','grant','reserve_redemption','pay_redemption','return_redemption')),
 ADD CHECK((kind='grant' AND challenge_id IS NULL AND external_ref IS NOT NULL AND redemption_id IS NULL)
 OR(kind IN('fund','settle','refund') AND challenge_id IS NOT NULL AND external_ref IS NULL AND redemption_id IS NULL)
 OR(kind IN('reserve_redemption','pay_redemption','return_redemption') AND challenge_id IS NULL AND redemption_id IS NOT NULL AND external_ref IS NOT NULL));
-- Preserve every existing seal. New payout journals bind their owner even when
-- a provider-confirmed payment moves only between liability accounts.
CREATE OR REPLACE FUNCTION race_private.grid_journal_payload(t uuid,tx uuid) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',2,'tenant_id',j.tenant_id,'transaction_id',j.id,'token_type',j.token_type,'kind',j.kind,'challenge_id',j.challenge_id,'redemption_id',j.redemption_id,'external_ref',j.external_ref,'created_at',to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'lines',(SELECT jsonb_agg(jsonb_build_object('id',l.id,'bucket',l.bucket,'user_id',l.user_id,'delta',l.delta::text) ORDER BY l.id) FROM race_private.journal_lines l WHERE(l.tenant_id,l.transaction_id)=(j.tenant_id,j.id))) FROM race_private.journal_transactions j WHERE j.tenant_id=t AND j.id=tx
$$;
DO $$DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('race_private.grid_seal_journal(uuid,uuid)'::regprocedure) INTO definition;
 definition:=replace(definition,'SELECT DISTINCT user_id FROM race_private.journal_lines WHERE tenant_id=t AND transaction_id=tx AND user_id IS NOT NULL ORDER BY user_id',
 'SELECT user_id FROM race_private.journal_lines WHERE tenant_id=t AND transaction_id=tx AND user_id IS NOT NULL UNION SELECT r.user_id FROM race_private.redemptions r JOIN race_private.journal_transactions j ON(j.tenant_id,j.redemption_id)=(r.tenant_id,r.id) WHERE j.tenant_id=t AND j.id=tx ORDER BY user_id');
 EXECUTE definition;
END $$;
CREATE FUNCTION race_private.cash_state(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u uuid:=race_private.customer_wallet(t);BEGIN
 RETURN jsonb_build_object('redeemable_sc',(SELECT sc_redeemable_balance::text FROM race_private.users WHERE tenant_id=t AND id=u),'kyc_reference_id',(SELECT kyc_reference_id FROM race_private.users WHERE tenant_id=t AND id=u),'kyc_status',(SELECT kyc_status FROM race_private.users WHERE tenant_id=t AND id=u),'bank_connected',EXISTS(SELECT 1 FROM race_private.payout_accounts WHERE tenant_id=t AND user_id=u AND account_id IS NOT NULL),'minimum_sc','50.00','maximum_sc','10000.00',
 'requests',coalesce((SELECT jsonb_agg(v ORDER BY v.created_at DESC) FROM(SELECT id,amount_sc::text,state,created_at,updated_at FROM race_private.redemptions WHERE tenant_id=t AND user_id=u ORDER BY created_at DESC LIMIT 50)v),'[]'::jsonb));
END $$;
CREATE FUNCTION race_private.cash_begin_kyc(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid:=race_private.customer_wallet(t);BEGIN
 UPDATE race_private.users SET kyc_status=CASE WHEN kyc_status='Verified' THEN kyc_status ELSE 'Pending'::race_private.kyc_status END WHERE tenant_id=t AND id=u;
 RETURN jsonb_build_object('external_user_id',t::text||':'||race_private.customer_identity()::text);
END $$;
CREATE FUNCTION race_private.cash_record_kyc(t uuid,actor uuid,receipt text,applicant text,status text,observed timestamptz,sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid;old race_private.kyc_receipts%ROWTYPE;BEGIN
 IF status IS NULL OR status NOT IN('Unverified','Pending','Verified') OR applicant !~ '^[a-f0-9]{24}$' OR length(receipt)>200 OR observed IS NULL OR observed>clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'invalid_kyc_receipt' USING ERRCODE='PT400';END IF;
 SELECT id INTO u FROM race_private.users WHERE tenant_id=t AND auth_user_id=actor FOR NO KEY UPDATE;
 IF u IS NULL THEN RAISE EXCEPTION 'unknown_account' USING ERRCODE='PT404';END IF;
 SELECT * INTO old FROM race_private.kyc_receipts WHERE tenant_id=t AND id=receipt;
 IF FOUND THEN IF(old.user_id,old.applicant_id,old.status::text,old.sha256) IS DISTINCT FROM(u,applicant,status,sha) THEN RAISE EXCEPTION 'receipt_conflict' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('duplicate',true);END IF;
 INSERT INTO race_private.kyc_receipts VALUES(t,u,receipt,applicant,status::race_private.kyc_status,observed,sha,clock_timestamp());
 UPDATE race_private.users SET kyc_status=status::race_private.kyc_status,kyc_reference_id=applicant,kyc_checked_at=observed WHERE tenant_id=t AND id=u AND(kyc_checked_at IS NULL OR kyc_checked_at<observed);
 RETURN jsonb_build_object('recorded',true);
END $$;
CREATE FUNCTION race_private.cash_begin_account(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid:=race_private.customer_wallet(t);BEGIN
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=u FOR NO KEY UPDATE;
 INSERT INTO race_private.payout_accounts(tenant_id,user_id) VALUES(t,u) ON CONFLICT DO NOTHING;
 RETURN(SELECT jsonb_build_object('user_id',u,'intent_id',intent_id,'started_at',started_at,'account_id',account_id) FROM race_private.payout_accounts WHERE tenant_id=t AND user_id=u);
END $$;
CREATE FUNCTION race_private.cash_bind_account(t uuid,u uuid,intent uuid,account text,bank text,ready boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
BEGIN
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=u FOR NO KEY UPDATE;
 UPDATE race_private.payout_accounts SET account_id=account,bank_id=bank,ready_until=CASE WHEN ready THEN clock_timestamp()+interval '10 minutes' ELSE NULL END WHERE tenant_id=t AND user_id=u AND intent_id=intent AND(account_id IS NULL OR account_id=account);
 IF NOT FOUND THEN RAISE EXCEPTION 'account_binding_conflict' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('bound',true);
END $$;
CREATE FUNCTION race_private.execute_atomic_withdrawal_debit(t uuid,request uuid,amount text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid:=race_private.customer_wallet(t);n numeric(24,6);old race_private.redemptions%ROWTYPE;a race_private.payout_accounts%ROWTYPE;tx uuid;program uuid;BEGIN
 IF request IS NULL OR amount IS NULL OR amount !~ '^[0-9]{1,5}(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE='PT400';END IF;
 n:=amount::numeric;IF n<50 OR n>10000 THEN RAISE EXCEPTION 'redemption_limits' USING ERRCODE='PT400';END IF;
 PERFORM id FROM race_private.users WHERE tenant_id=t AND id=u FOR NO KEY UPDATE;
 SELECT * INTO old FROM race_private.redemptions WHERE tenant_id=t AND id=request;
 IF FOUND THEN IF(old.user_id,old.amount_sc) IS DISTINCT FROM(u,n) THEN RAISE EXCEPTION 'redemption_conflict' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('id',old.id,'state',old.state,'amount_sc',old.amount_sc::text,'duplicate',true);END IF;
 PERFORM race_private.customer_can_play(t,u,'SC');
 IF NOT EXISTS(SELECT 1 FROM race_private.users WHERE tenant_id=t AND id=u AND kyc_status='Verified' AND kyc_checked_at>clock_timestamp()-interval '1 day') THEN RAISE EXCEPTION 'kyc_required' USING ERRCODE='PT403';END IF;
 SELECT * INTO a FROM race_private.payout_accounts WHERE tenant_id=t AND user_id=u;
 IF a.account_id IS NULL OR a.bank_id IS NULL OR a.ready_until IS NULL OR a.ready_until<=clock_timestamp() THEN RAISE EXCEPTION 'bank_verification_required' USING ERRCODE='PT403';END IF;
 IF(SELECT count(*) FROM race_private.redemptions WHERE tenant_id=t AND user_id=u AND state NOT IN('Paid','Returned'))>=3 OR(SELECT coalesce(sum(amount_sc),0) FROM race_private.redemptions WHERE tenant_id=t AND user_id=u AND created_at>clock_timestamp()-interval '1 day' AND state<>'Returned')+n>10000 THEN RAISE EXCEPTION 'daily_redemption_limit' USING ERRCODE='PT429';END IF;
 UPDATE race_private.users SET sc_balance=sc_balance-n,sc_redeemable_balance=sc_redeemable_balance-n,updated_at=clock_timestamp() WHERE tenant_id=t AND id=u AND sc_balance>=n AND sc_redeemable_balance>=n;
 IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_balance' USING ERRCODE='PT409';END IF;
 program:=(race_private.grid_program(t)->>'id')::uuid;
 INSERT INTO race_private.redemptions(tenant_id,id,user_id,amount_sc,account_id,bank_id,program_id) VALUES(t,request,u,n,a.account_id,a.bank_id,program);
 INSERT INTO race_private.journal_transactions(tenant_id,token_type,kind,external_ref,redemption_id) VALUES(t,'SC','reserve_redemption','redemption:reserve:'||request,request) RETURNING id INTO tx;
 INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES(t,tx,'User',u,-n),(t,tx,'Redemption',NULL,n);
 RETURN jsonb_build_object('id',request,'state','Reserved','amount_sc',n::text,'duplicate',false);
END $$;
CREATE FUNCTION race_private.cash_lease() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE r race_private.redemptions%ROWTYPE;token uuid:=gen_random_uuid();BEGIN
 SELECT * INTO r FROM race_private.redemptions WHERE next_attempt_at<=clock_timestamp() AND(lease_until IS NULL OR lease_until<clock_timestamp()) AND state NOT IN('Returned','Review') ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('empty',true);END IF;
 UPDATE race_private.redemptions SET lease_token=token,lease_until=clock_timestamp()+interval '5 minutes',attempts=attempts+1 WHERE tenant_id=r.tenant_id AND id=r.id;
 RETURN to_jsonb(r)||jsonb_build_object('lease_token',token,'amount_sc',r.amount_sc::text,'kyc_status',(SELECT kyc_status FROM race_private.users WHERE tenant_id=r.tenant_id AND id=r.user_id));
END $$;
CREATE FUNCTION race_private.cash_start_phase(t uuid,request uuid,lease uuid,phase text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE r race_private.redemptions%ROWTYPE;BEGIN
 SELECT * INTO r FROM race_private.redemptions WHERE tenant_id=t AND id=request FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM lease OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE='PT409';END IF;
 IF phase='transfer' AND r.state='Reserved' THEN
  IF NOT EXISTS(SELECT 1 FROM race_private.users u JOIN race_private.profiles p ON(p.tenant_id,p.user_id)=(u.tenant_id,u.id) WHERE u.tenant_id=t AND u.id=r.user_id AND u.enabled AND u.kyc_status='Verified' AND NOT p.payment_review) OR EXISTS(SELECT 1 FROM race_private.risk_cases c WHERE c.tenant_id=t AND c.user_id=r.user_id AND NOT EXISTS(SELECT 1 FROM race_private.risk_resolutions z WHERE(z.tenant_id,z.case_id)=(c.tenant_id,c.id))) THEN RAISE EXCEPTION 'account_review' USING ERRCODE='PT403';END IF;
  UPDATE race_private.redemptions SET transfer_started_at=coalesce(transfer_started_at,clock_timestamp()) WHERE tenant_id=t AND id=request;
 ELSIF phase='payout' AND r.state='Transferred' THEN UPDATE race_private.redemptions SET payout_started_at=coalesce(payout_started_at,clock_timestamp()) WHERE tenant_id=t AND id=request;
 ELSIF phase='reversal' AND r.state='Reversing' THEN UPDATE race_private.redemptions SET reversal_started_at=coalesce(reversal_started_at,clock_timestamp()) WHERE tenant_id=t AND id=request;
 ELSE RAISE EXCEPTION 'invalid_phase' USING ERRCODE='PT409';END IF;
 RETURN(SELECT to_jsonb(v)||jsonb_build_object('amount_sc',v.amount_sc::text) FROM race_private.redemptions v WHERE tenant_id=t AND id=request);
END $$;
CREATE FUNCTION race_private.cash_record(t uuid,request uuid,lease uuid,phase text,object_id text,receipt text,sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE r race_private.redemptions%ROWTYPE;tx uuid;old race_private.redemption_receipts%ROWTYPE;BEGIN
 SELECT * INTO r FROM race_private.redemptions WHERE tenant_id=t AND id=request FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM lease OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'lease_lost' USING ERRCODE='PT409';END IF;
 SELECT * INTO old FROM race_private.redemption_receipts WHERE tenant_id=t AND id=receipt;
 IF FOUND THEN IF(old.redemption_id,old.phase,old.provider_id,old.sha256) IS DISTINCT FROM(request,phase,object_id,sha) THEN RAISE EXCEPTION 'receipt_conflict' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('duplicate',true);END IF;
 IF phase='transfer' AND r.state='Reserved' AND object_id~'^tr_[A-Za-z0-9]+$' THEN UPDATE race_private.redemptions SET transfer_id=object_id,state='Transferred' WHERE tenant_id=t AND id=request;
 ELSIF phase='payout' AND r.state='Transferred' AND object_id~'^po_[A-Za-z0-9]+$' THEN UPDATE race_private.redemptions SET payout_id=object_id,state='PayoutPending' WHERE tenant_id=t AND id=request;
 ELSIF phase='paid' AND r.state='PayoutPending' AND object_id=r.payout_id THEN
  UPDATE race_private.redemptions SET state='Paid' WHERE tenant_id=t AND id=request;
  INSERT INTO race_private.journal_transactions(tenant_id,token_type,kind,external_ref,redemption_id) VALUES(t,'SC','pay_redemption','redemption:paid:'||request,request) RETURNING id INTO tx;
  INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,delta) VALUES(t,tx,'Redemption',-r.amount_sc),(t,tx,'Disbursement',r.amount_sc);
  INSERT INTO race_private.redemption_tax_events(tenant_id,redemption_id,kind,amount_usd) VALUES(t,request,'Paid',r.amount_sc);
 ELSIF phase='failed' AND r.state IN('PayoutPending','Paid') AND object_id=r.payout_id THEN UPDATE race_private.redemptions SET state='Reversing' WHERE tenant_id=t AND id=request;
 ELSIF phase='returned' AND r.state='Reversing' AND object_id=r.transfer_id THEN
  PERFORM id FROM race_private.users WHERE tenant_id=t AND id=r.user_id FOR NO KEY UPDATE;
  UPDATE race_private.users SET sc_balance=sc_balance+r.amount_sc,sc_redeemable_balance=sc_redeemable_balance+r.amount_sc,updated_at=clock_timestamp() WHERE tenant_id=t AND id=r.user_id;
  INSERT INTO race_private.journal_transactions(tenant_id,token_type,kind,external_ref,redemption_id) VALUES(t,'SC','return_redemption','redemption:returned:'||request,request) RETURNING id INTO tx;
  INSERT INTO race_private.journal_lines(tenant_id,transaction_id,bucket,user_id,delta) VALUES(t,tx,CASE WHEN EXISTS(SELECT 1 FROM race_private.redemption_tax_events WHERE tenant_id=t AND redemption_id=request AND kind='Paid') THEN 'Disbursement'::race_private.bucket ELSE 'Redemption'::race_private.bucket END,NULL,-r.amount_sc),(t,tx,'User',r.user_id,r.amount_sc);
  IF EXISTS(SELECT 1 FROM race_private.redemption_tax_events WHERE tenant_id=t AND redemption_id=request AND kind='Paid') THEN INSERT INTO race_private.redemption_tax_events(tenant_id,redemption_id,kind,amount_usd) VALUES(t,request,'Returned',-r.amount_sc);END IF;
  UPDATE race_private.redemptions SET state='Returned' WHERE tenant_id=t AND id=request;
 ELSIF phase='review' THEN UPDATE race_private.redemptions SET state='Review' WHERE tenant_id=t AND id=request;
 ELSE RAISE EXCEPTION 'invalid_transition' USING ERRCODE='PT409';END IF;
 INSERT INTO race_private.redemption_receipts VALUES(t,request,receipt,phase,object_id,sha,clock_timestamp());
 UPDATE race_private.redemptions SET updated_at=clock_timestamp() WHERE tenant_id=t AND id=request;
 RETURN jsonb_build_object('recorded',true);
END $$;
CREATE FUNCTION race_private.cash_release(t uuid,request uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE race_private.redemptions SET lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN state='Paid' THEN interval '1 day' ELSE interval '1 minute' END WHERE tenant_id=t AND id=request AND lease_token=lease;RETURN jsonb_build_object('released',FOUND);END $$;
CREATE FUNCTION race_private.cash_wake_review(t uuid,provider uuid,request uuid,receipt uuid,reason text,sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE r race_private.redemptions%ROWTYPE;next_state text;BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=provider AND enabled) OR length(reason) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'review_operator_required' USING ERRCODE='PT403';END IF;
 SELECT * INTO r FROM race_private.redemptions WHERE tenant_id=t AND id=request FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='PT404';END IF;
 IF EXISTS(SELECT 1 FROM race_private.redemption_receipts WHERE tenant_id=t AND id='resume:'||receipt::text AND redemption_id=request AND sha256=sha) THEN RETURN jsonb_build_object('duplicate',true);END IF;
 IF r.state<>'Review' OR r.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'request_not_in_review' USING ERRCODE='PT409';END IF;
 next_state:=CASE WHEN EXISTS(SELECT 1 FROM race_private.redemption_receipts WHERE tenant_id=t AND redemption_id=request AND phase='failed') THEN 'Reversing' WHEN EXISTS(SELECT 1 FROM race_private.redemption_tax_events WHERE tenant_id=t AND redemption_id=request AND kind='Paid') THEN 'Paid' WHEN r.payout_id IS NOT NULL THEN 'PayoutPending' WHEN r.transfer_id IS NOT NULL THEN 'Transferred' ELSE 'Reserved' END;
 UPDATE race_private.redemptions SET state=next_state,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE tenant_id=t AND id=request;
 INSERT INTO race_private.redemption_receipts VALUES(t,request,'resume:'||receipt::text,'resume',provider::text,sha,clock_timestamp());
 RETURN jsonb_build_object('id',request,'state',next_state,'duplicate',false);
END $$;
CREATE FUNCTION race_private.cash_tax_export(t uuid,year integer) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) FROM(SELECT r.user_id,sum(e.amount_usd) FILTER(WHERE e.kind='Paid')::text AS gross_usd,coalesce(-sum(e.amount_usd) FILTER(WHERE e.kind='Returned'),0)::text AS returned_usd,sum(e.amount_usd)::text AS net_usd FROM race_private.redemption_tax_events e JOIN race_private.redemptions r ON(r.tenant_id,r.id)=(e.tenant_id,e.redemption_id) WHERE e.tenant_id=t AND extract(year FROM e.occurred_at AT TIME ZONE 'UTC')=year GROUP BY r.user_id ORDER BY r.user_id)v
$$;
CREATE TABLE race_private.postal_ame_receipts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,provider_id uuid NOT NULL,user_id uuid NOT NULL,program_id uuid NOT NULL,document_sha256 text NOT NULL CHECK(document_sha256~'^[a-f0-9]{64}$'),payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),received_at timestamptz NOT NULL,authorization_reference text NOT NULL CHECK(length(authorization_reference) BETWEEN 10 AND 500),journal_id uuid NOT NULL,credited_sc numeric(24,6) NOT NULL CHECK(credited_sc=5),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,document_sha256),FOREIGN KEY(tenant_id,provider_id) REFERENCES race_private.providers(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES race_private.users(tenant_id,id),FOREIGN KEY(tenant_id,program_id) REFERENCES race_private.promotion_programs(tenant_id,id),FOREIGN KEY(tenant_id,journal_id) REFERENCES race_private.journal_transactions(tenant_id,id));
CREATE FUNCTION race_private.cash_postal(t uuid,provider uuid,request uuid,actor uuid,program uuid,document text,received timestamptz,auth_ref text,sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE u uuid;old race_private.postal_ame_receipts%ROWTYPE;e jsonb;tx jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM race_private.providers WHERE tenant_id=t AND id=provider AND enabled) THEN RAISE EXCEPTION 'operator_required' USING ERRCODE='PT403';END IF;
 SELECT id INTO u FROM race_private.users WHERE tenant_id=t AND auth_user_id=actor FOR NO KEY UPDATE;
 IF u IS NULL THEN RAISE EXCEPTION 'account_not_found' USING ERRCODE='PT404';END IF;
 SELECT * INTO old FROM race_private.postal_ame_receipts WHERE tenant_id=t AND id=request;
 IF FOUND THEN IF(old.user_id,old.provider_id,old.program_id,old.document_sha256,old.payload_sha256) IS DISTINCT FROM(u,provider,program,document,sha) THEN RAISE EXCEPTION 'postal_receipt_conflict' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('id',request,'credited_sc',old.credited_sc::text,'duplicate',true);END IF;
 PERFORM program_id FROM race_private.program_activations WHERE tenant_id=t FOR SHARE;
 e:=race_private.grid_eligibility(t,u);
 IF(e->>'eligible')::boolean IS DISTINCT FROM true OR e->'program'->>'id' IS DISTINCT FROM program::text OR NOT EXISTS(SELECT 1 FROM race_private.promotion_programs WHERE tenant_id=t AND id=program AND free_sc=5 AND received>=starts_at AND received<ends_at) OR received IS NULL OR received>clock_timestamp() THEN RAISE EXCEPTION 'postal_program_or_eligibility_required' USING ERRCODE='PT403';END IF;
 PERFORM race_private.customer_can_play(t,u,'SC');
 tx:=race_private.credit_wallet(t,u,'SC',5,'postal:'||request::text);
 INSERT INTO race_private.postal_ame_receipts(tenant_id,id,provider_id,user_id,program_id,document_sha256,payload_sha256,received_at,authorization_reference,journal_id,credited_sc) VALUES(t,request,provider,u,program,document,sha,received,auth_ref,(tx->>'transaction_id')::uuid,5);
 RETURN jsonb_build_object('id',request,'credited_sc','5.000000','duplicate',false);
END $$;
CREATE FUNCTION public.cash_postal(p_tenant_id uuid,p_provider_id uuid,p_receipt_id uuid,p_auth_user_id uuid,p_program_id uuid,p_document_sha256 text,p_received_at timestamptz,p_authorization_reference text,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_postal(p_tenant_id,p_provider_id,p_receipt_id,p_auth_user_id,p_program_id,p_document_sha256,p_received_at,p_authorization_reference,p_payload_sha256)$$;
-- No direct balance, identity or lifecycle writes from any API role.
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['kyc_receipts','payout_accounts','redemptions','redemption_receipts','redemption_tax_events','postal_ame_receipts'] LOOP
 EXECUTE format('ALTER TABLE race_private.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE race_private.%I FORCE ROW LEVEL SECURITY',n);EXECUTE format('REVOKE ALL ON race_private.%I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['kyc_receipts','redemption_receipts','redemption_tax_events','postal_ame_receipts'] LOOP EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON race_private.%I FOR EACH ROW EXECUTE FUNCTION race_private.immutable_record()',n);END LOOP;
END $$;
-- Explicit public invoker wrappers. End-user functions always derive the owner
-- from a live Supabase session; service functions require the server role.
CREATE FUNCTION public.cash_state(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_state(p_tenant_id)$$;
CREATE FUNCTION public.cash_begin_kyc(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_begin_kyc(p_tenant_id)$$;
CREATE FUNCTION public.cash_begin_account(p_tenant_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_begin_account(p_tenant_id)$$;
CREATE FUNCTION public.execute_atomic_withdrawal_debit(p_tenant_id uuid,p_request_id uuid,p_amount_sc text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.execute_atomic_withdrawal_debit(p_tenant_id,p_request_id,p_amount_sc)$$;
CREATE FUNCTION public.cash_record_kyc(p_tenant_id uuid,p_auth_user_id uuid,p_receipt_id text,p_applicant_id text,p_status text,p_observed_at timestamptz,p_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_record_kyc(p_tenant_id,p_auth_user_id,p_receipt_id,p_applicant_id,p_status,p_observed_at,p_sha256)$$;
CREATE FUNCTION public.cash_bind_account(p_tenant_id uuid,p_user_id uuid,p_intent_id uuid,p_account_id text,p_bank_id text,p_ready boolean) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_bind_account(p_tenant_id,p_user_id,p_intent_id,p_account_id,p_bank_id,p_ready)$$;
CREATE FUNCTION public.cash_lease() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_lease()$$;
CREATE FUNCTION public.cash_start_phase(p_tenant_id uuid,p_request_id uuid,p_lease_token uuid,p_phase text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_start_phase(p_tenant_id,p_request_id,p_lease_token,p_phase)$$;
CREATE FUNCTION public.cash_record(p_tenant_id uuid,p_request_id uuid,p_lease_token uuid,p_phase text,p_object_id text,p_receipt_id text,p_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_record(p_tenant_id,p_request_id,p_lease_token,p_phase,p_object_id,p_receipt_id,p_sha256)$$;
CREATE FUNCTION public.cash_release(p_tenant_id uuid,p_request_id uuid,p_lease_token uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_release(p_tenant_id,p_request_id,p_lease_token)$$;
CREATE FUNCTION public.cash_wake_review(p_tenant_id uuid,p_provider_id uuid,p_request_id uuid,p_receipt_id uuid,p_reason text,p_payload_sha256 text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_wake_review(p_tenant_id,p_provider_id,p_request_id,p_receipt_id,p_reason,p_payload_sha256)$$;
CREATE FUNCTION public.cash_tax_export(p_tenant_id uuid,p_year integer) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$SELECT race_private.cash_tax_export(p_tenant_id,p_year)$$;
DO $$DECLARE f record;roles text;BEGIN FOR f IN SELECT p.oid::regprocedure AS sig,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','race_private') AND(p.proname LIKE 'cash_%' OR p.proname='execute_atomic_withdrawal_debit') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
 roles:=CASE WHEN f.proname IN('cash_state','cash_begin_kyc','cash_begin_account','execute_atomic_withdrawal_debit') THEN 'authenticated' ELSE 'service_role' END;
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s',f.sig,roles);
END LOOP;END $$;
COMMIT;
