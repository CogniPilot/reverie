"""Read normalized per-account plan windows; never infer a quota reset from the clock."""
from __future__ import annotations
import math
import time
from .runtime import Reverie


def capacity(reading, now=None, reserve_percent=5, max_age_seconds=600):
    now=time.time() if now is None else now
    result={'profile':reading.get('id'),'available':False,'windows':[],'reason':'usage unavailable'}
    if reading.get('status')!='ready' or not isinstance(reading.get('usage'),dict): return result
    updated=reading.get('updatedAt')
    if not isinstance(updated,(int,float)) or not math.isfinite(updated) or not 0<=now-updated/1000<=max_age_seconds:
        result['reason']='usage reading is stale'; return result
    blocked=[]
    for name in ('fiveHour','sevenDay'):
        window=reading['usage'].get(name)
        if window is None: continue
        used=window.get('usedPercentage'); reset=window.get('resetAt')
        if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in (used,reset)):
            result['reason']='invalid usage window'; return result
        reset/=1000
        result['windows'].append({'name':name,'used_percent':used,'reset_at':reset})
        if reset<=now:
            result['reason']='reset passed; awaiting fresh provider reading'; return result
        if used>=100-reserve_percent: blocked.append(reset)
    if not result['windows']: return result
    result['available']=not blocked
    result['reason']='available' if not blocked else 'plan reserve or quota reached'
    result['next_reset']=min(w['reset_at'] for w in result['windows'])
    result['retry_at']=max(blocked) if blocked else None
    return result


class PlanMonitor:
    def __init__(self, api_url, ledger, reserve_percent=5, max_age_seconds=600, api=None):
        self.api=api or Reverie(api_url); self.ledger=ledger
        self.reserve=reserve_percent; self.max_age=max_age_seconds
        ledger.db.execute('CREATE TABLE IF NOT EXISTS plan_samples (profile TEXT, sampled_at REAL, body TEXT)')
        ledger.db.commit()

    def refresh(self, now=None):
        import json
        now=time.time() if now is None else now
        value=self.api.call('GET','/api/subscription-profiles/usage')
        accounts=value.get('accounts',[])
        result={}
        with self.ledger.db:
            for reading in accounts:
                status=capacity(reading,now,self.reserve,self.max_age)
                result[status['profile']]=status
                # Metadata only: no credentials, raw conversations or provider payload dumps.
                self.ledger.db.execute('INSERT INTO plan_samples VALUES (?,?,?)',
                                       (status['profile'],now,json.dumps(status)))
            self.ledger.db.execute('DELETE FROM plan_samples WHERE sampled_at<?',(now-30*86400,))
        return result
