"""Durable, conservative accounting for scheduled model work; no conversation logs."""
from __future__ import annotations
import json
import math
import sqlite3
import time
import urllib.request
import uuid
from pathlib import Path
from .llm import ChatClient, LLMError


class Deferred(RuntimeError):
    """Work can wait without being claimed as complete."""


class BudgetExhausted(Deferred):
    pass


class Ledger:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS usage (
          id TEXT PRIMARY KEY, day TEXT, agent TEXT, phase TEXT, resource TEXT,
          tokens INTEGER, seconds REAL, status TEXT, reported INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS usage_scope ON usage(day,resource,agent,phase);
        CREATE TABLE IF NOT EXISTS phases (
          day TEXT, agent TEXT, phase TEXT, status TEXT, started REAL, finished REAL,
          detail TEXT, PRIMARY KEY(day,agent,phase));
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, agent TEXT, status TEXT, receipt TEXT);
        """)
        path.chmod(0o600)

    def usage(self, day, agent=None, phase=None, resource=None):
        clauses, values = ["day=?"], [day]
        for key, value in (("agent",agent),("phase",phase),("resource",resource)):
            if value is not None: clauses.append(key+"=?"); values.append(value)
        row = self.db.execute("SELECT COALESCE(SUM(tokens),0), COALESCE(SUM(seconds),0) FROM usage WHERE " +
                              " AND ".join(clauses), values).fetchone()
        return {"tokens":row[0], "seconds":row[1]}

    def reserve(self, day, agent, phase, resource, tokens, seconds, phase_cap, resource_cap):
        if tokens < 0 or seconds <= 0 or not math.isfinite(seconds):
            raise ValueError("invalid resource reservation")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            own = self.usage(day,agent,phase)
            shared = self.usage(day,resource=resource)
            for used, cap in ((own,phase_cap),(shared,resource_cap)):
                if used["tokens"]+tokens > cap["max_tokens"] or used["seconds"]+seconds > cap["max_seconds"]:
                    raise BudgetExhausted("scheduled compute budget exhausted")
            key = uuid.uuid4().hex
            self.db.execute("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,0)",
                (key,day,agent,phase,resource,tokens,seconds,"reserved"))
            self.db.commit()
            return key
        except BaseException:
            self.db.rollback(); raise

    def finish(self, key, tokens=None, seconds=None, status="completed"):
        with self.db:
            row = self.db.execute("SELECT * FROM usage WHERE id=?",(key,)).fetchone()
            if not row: raise ValueError("unknown reservation")
            # Unknown/failed usage keeps its reservation; never assume a failed call was free.
            self.db.execute("UPDATE usage SET tokens=?,seconds=?,status=?,reported=? WHERE id=?",
                (max(0,tokens) if tokens is not None else row["tokens"],
                 max(0,seconds) if seconds is not None else row["seconds"], status,
                 int(tokens is not None),key))

    def claim_phase(self, day, agent, phase):
        with self.db:
            return self.db.execute("INSERT OR IGNORE INTO phases VALUES (?,?,?,?,?,NULL,'')",
                                  (day,agent,phase,"running",time.time())).rowcount == 1

    def finish_phase(self, day, agent, phase, status, detail=""):
        with self.db:
            self.db.execute("UPDATE phases SET status=?,finished=?,detail=? WHERE day=? AND agent=? AND phase=?",
                            (status,time.time(),detail,day,agent,phase))

    def phases(self, day, agent):
        return [dict(r) for r in self.db.execute("SELECT * FROM phases WHERE day=? AND agent=? ORDER BY started",
                                               (day,agent))]

    def close(self): self.db.close()


class MeteredClient(ChatClient):
    def __init__(self, model, ledger, day, agent, phase, phase_cap, resource_cap, transport=None):
        self.profile=model; self.ledger=ledger; self.day=day; self.agent=agent; self.phase=phase
        self.phase_cap=phase_cap; self.resource_cap=resource_cap
        super().__init__(model["api_base"], model["model"], min(240,phase_cap["max_seconds"]),
                         transport=self.metered_transport)
        self.wire=transport or self.http
        self.last_usage=None

    def http(self, url, body, timeout):
        import os
        headers={"Content-Type":"application/json"}
        if self.profile.get("api_key_env"):
            token=os.environ.get(self.profile["api_key_env"])
            if not token: raise LLMError("model credential is unavailable")
            headers["Authorization"]="Bearer "+token
        with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers),timeout=timeout) as r:
            return r.read()

    def metered_transport(self, url, body, timeout):
        request=json.loads(body)
        # UTF-8 size plus per-message framing is a conservative preflight estimate.
        prompt=sum(len(str(m.get("content","")).encode())+32 for m in request["messages"])+128
        own=self.ledger.usage(self.day,self.agent,self.phase)
        shared=self.ledger.usage(self.day,resource=self.profile["resource"])
        remaining=min(self.phase_cap["max_tokens"]-own["tokens"],
                      self.resource_cap["max_tokens"]-shared["tokens"])
        output=min(request["max_tokens"],self.profile["output_tokens"],remaining-prompt,
                   self.profile["context_window"]-prompt-512)
        if output < 32: raise BudgetExhausted("insufficient room for model input and output")
        seconds=min(timeout,self.phase_cap["max_seconds"]-own["seconds"],
                    self.resource_cap["max_seconds"]-shared["seconds"])
        if seconds < 1: raise BudgetExhausted("scheduled compute time exhausted")
        request["max_tokens"]=int(output)
        key=self.ledger.reserve(self.day,self.agent,self.phase,self.profile["resource"],
                                prompt+int(output),seconds,self.phase_cap,self.resource_cap)
        started=time.monotonic()
        try:
            raw=self.wire(url,json.dumps(request).encode(),seconds)
            result=json.loads(raw)
            usage=result.get("usage",{})
            total=usage.get("total_tokens")
            if total is None and all(isinstance(usage.get(k),int) for k in ("prompt_tokens","completion_tokens")):
                total=usage["prompt_tokens"]+usage["completion_tokens"]
            if not isinstance(total,int) or isinstance(total,bool) or total < 0: total=None
            self.ledger.finish(key,total,time.monotonic()-started)
            self.last_usage=total
            return raw
        except BaseException:
            self.ledger.finish(key,seconds=time.monotonic()-started,status="failed_or_unknown")
            raise
