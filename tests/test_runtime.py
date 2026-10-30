import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
from pathlib import Path
import fcntl
import json
import sys
import subprocess
import signal
import time
import os
import tempfile
import unittest
import urllib.error
import urllib.parse
import io
from unittest.mock import patch
from reverie.runtime import Runtime, atomic_write

class FakeAPI:
    def __init__(self): self.calls=[]; self.session={"pid":12,"paneExit":None}; self.fail=False
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        if self.fail: raise TimeoutError("ambiguous network timeout")
        if method=="POST": return {"sessionId":"candidate-id", "caseName":"test-reverie"}
        if "chatrooms" in path: return {"coordinatorId":"old-id"}
        return {"session":self.session}

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.path=self.root/"policy.json"
        self.policy={"api_url":"http://localhost:3000", "case_name":"test-reverie", "state_file":"state.json",
            "pause_file":"paused", "fallback":"local", "backends":{
                "local":{"mode":"opencode","model":"local/qwen","enabled":True},
                "cloud":{"mode":"codex","model":"configured-model","enabled":True},
                "disabled":{"mode":"claude","model":"configured-model","enabled":False}}}
        self.path.write_text(json.dumps(self.policy)); self.api=FakeAPI(); self.runtime=Runtime(self.path,self.api,cgroup=self.root/"no-cgroup")

    def test_client_propagates_session_header(self):
        from reverie.runtime import Reverie
        with patch.dict(os.environ, {"REVERIE_SESSION_ID": "session-a"}, clear=True):
            with patch("reverie.runtime.urllib.request.urlopen", return_value=io.BytesIO(b'{"success":true,"data":{}}')) as opened:
                Reverie("http://localhost:3000").call("GET", "/api/sessions")
                headers = {k.lower(): v for k, v in opened.call_args.args[0].headers.items()}
                self.assertEqual(headers["x-reverie-parent-session"], "session-a")

    def test_switch_saves_handoff_and_maps_backend_without_erasing_history(self):
        self.runtime.state={"current":"old-id", "backend":"local"}
        result=self.runtime.start("cloud","Verified handoff")
        self.assertEqual(result["session_id"],"candidate-id")
        body=self.api.calls[0][2]
        self.assertEqual(body["codexConfig"]["model"],"configured-model")
        self.assertEqual(self.runtime.state["current"],"old-id")
        self.assertEqual(json.loads((self.root/"state.json").read_text())["handoff"],"Verified handoff")
        with self.assertRaises(ValueError): self.runtime.start("cloud","second")
        activated=self.runtime.activate("candidate-id")
        self.assertEqual(activated["previous"],"old-id")
        self.assertFalse(any(method=="DELETE" for method,_,_ in self.api.calls))

    def test_recovery_preserves_configured_agent_name_without_cto_title(self):
        self.runtime.policy["session_name"] = "Local Assistant"
        self.runtime.start("local", "Verified handoff")
        self.assertEqual(self.api.calls[0][2]["sessionName"], "Local Assistant")
        self.assertEqual(self.runtime.session_name("cloud"), "Local Assistant")
        self.runtime.policy["session_name"] = " "
        with self.assertRaises(ValueError):
            self.runtime.session_name("local")

    def test_uncertain_creation_is_not_retried(self):
        self.api.fail=True
        with self.assertRaises(TimeoutError): self.runtime.start("cloud","handoff")
        reopened=Runtime(self.path,self.api)
        self.assertTrue(reopened.state["creation_uncertain"])
        self.assertTrue(reopened.check()["pending"])
        self.assertEqual(len(self.api.calls),1)

    def test_idle_approval_pause_and_clean_exit_do_not_spawn(self):
        self.runtime.state={"current":"old-id"}
        self.assertTrue(self.runtime.check()["healthy"])
        self.api.session["paneDialog"]="Approval required"
        self.assertTrue(self.runtime.check()["needs_attention"])
        (self.root/"paused").touch(); self.assertTrue(self.runtime.check()["paused"])
        (self.root/"paused").unlink()
        self.api.session={"pid":None,"paneExit":{"status":0}}
        self.assertTrue(self.runtime.check()["stopped"])
        self.assertFalse(any(method=="POST" for method,_,_ in self.api.calls))

    def test_switch_first_prompt_starts_with_the_employee_memory_brief(self):
        BRIEF="Your memory: you are Otto, a persistent Reverie employee. Keystone: no AI in branch names."
        runtime=Runtime(self.path,self.api,cgroup=self.root/"no-cgroup",brief=lambda: BRIEF)
        runtime.state={"current":"old-id","backend":"local"}
        result=runtime.start("cloud","Verified handoff")
        self.assertEqual(result["first_prompt"],BRIEF+" Verified handoff")
        self.assertTrue(result["memory_brief"])
        saved=json.loads((self.root/"state.json").read_text())
        self.assertEqual(saved["handoff"],"Verified handoff")  # the agent's handoff alone
        self.assertEqual(saved["first_prompt"],BRIEF+" Verified handoff")

    def test_send_command_keeps_journal_text_as_one_argument(self):
        import shlex
        BRIEF="Keystone: James's rule $(touch /tmp/pwned) `id` \\ \"quoted\" -- not an option"
        runtime=Runtime(self.path,self.api,cgroup=self.root/"no-cgroup",brief=lambda: BRIEF)
        result=runtime.start("cloud","-starts with a dash; it's fine")
        argv=shlex.split(result["send_command"])
        self.assertEqual(argv,["reverie","agent","send","candidate-id","--",BRIEF+" -starts with a dash; it's fine"])
        self.assertEqual(argv[-1],result["first_prompt"])
        self.assertEqual(json.loads((self.root/"state.json").read_text())["send_command"],result["send_command"])

    def test_switch_without_a_brief_sends_the_handoff_alone(self):
        result=self.runtime.start("cloud","Verified handoff")  # no agent session here: no brief is fetched
        self.assertEqual(result["first_prompt"],"Verified handoff")
        self.assertFalse(result["memory_brief"])

    def test_recovery_after_a_switch_carries_exactly_one_brief(self):
        BRIEF="Your memory: you are Otto."
        runtime=Runtime(self.path,self.api,cgroup=self.root/"no-cgroup",brief=lambda: BRIEF)
        runtime.state={"current":"old-id","backend":"cloud"}
        runtime.start("cloud","Saved work")
        runtime.state.update(candidate=None,current="candidate-id")
        self.api.session={"pid":None,"paneExit":{"status":1}}
        self.assertEqual(runtime.check(now=1000)["backend"],"local")
        self.assertEqual(runtime.state["first_prompt"].count(BRIEF),1)
        self.assertTrue(runtime.state["first_prompt"].startswith(BRIEF+" Saved work"))

    def test_memory_brief_is_the_agents_own_journal_brief_on_one_line(self):
        from reverie.runtime import memory_brief
        with patch.dict(os.environ,{},clear=True), patch("reverie.runtime.subprocess.run") as run:
            self.assertIsNone(memory_brief()); run.assert_not_called()  # outside an agent session: no CLI call
        done=subprocess.CompletedProcess([],0,json.dumps({"success":True,"data":{"text":"Your memory:\n- keystone one\n- newest two\n"}}),"")
        with patch.dict(os.environ,{"REVERIE_SESSION_ID":"session-a"}), patch("reverie.runtime.subprocess.run",return_value=done) as run:
            self.assertEqual(memory_brief(),"Your memory: - keystone one - newest two")
            self.assertEqual(run.call_args.args[0],["reverie","agent","journal","brief","--json"])
        for failure in (subprocess.CompletedProcess([],1,"",""), subprocess.CompletedProcess([],0,"not json","")):
            with patch.dict(os.environ,{"REVERIE_SESSION_ID":"session-a"}), patch("reverie.runtime.subprocess.run",return_value=failure):
                self.assertIsNone(memory_brief())
        with patch.dict(os.environ,{"REVERIE_SESSION_ID":"session-a"}), patch("reverie.runtime.subprocess.run",side_effect=subprocess.TimeoutExpired("reverie",15)):
            self.assertIsNone(memory_brief())

    def test_crash_provisions_local_and_budget_blocks_repeated_recovery(self):
        self.runtime.state={"current":"old-id", "backend":"cloud", "handoff":"Saved work"}
        self.api.session={"pid":None,"paneExit":{"status":1}}
        self.assertEqual(self.runtime.check(now=1000)["backend"],"local")
        self.runtime.state["candidate"]=None
        self.runtime.state["recovery_attempts"]=[1000,1001,1002]
        self.assertIn("blocked",self.runtime.check(now=1010))

    def test_disabled_profile_and_coordinator_gate_are_respected(self):
        with self.assertRaises(ValueError): self.runtime.start("disabled","handoff")
        self.runtime.start("local","handoff")
        self.runtime.policy["room_id"]="reverie-room"
        with self.assertRaisesRegex(ValueError,"owner must transfer"):
            self.runtime.activate("candidate-id")
        self.assertEqual(self.runtime.state["candidate"],"candidate-id")

    def test_confirmed_cloud_capacity_wait_can_provision_local_fallback(self):
        self.runtime.state={"current":"cloud-id", "backend":"cloud", "handoff":"Saved work"}
        self.api.session={"pid":42,"paneDialog":"Continuing automatically at 12:30am"}
        self.assertEqual(self.runtime.check(now=1000)["backend"],"local")

    def test_local_gpu_preflight_avoids_duplicate_recovery_and_checks_model_identity(self):
        self.runtime.policy["keep_alive"] = {"model_api_url":"http://gpu.example/v1", "model_id":"qwen"}
        self.runtime.state={"current":"cloud-id", "backend":"cloud", "handoff":"Saved work"}
        self.api.session={"pid":None,"paneExit":{"status":1}}
        with patch("reverie.runtime.urllib.request.urlopen", return_value=io.BytesIO(b'{"data":[]}')):
            result=self.runtime.check(now=1000)
        self.assertEqual(result["blocked"], "local keep-alive unavailable")
        self.assertNotIn("recovery_attempts", self.runtime.state)
        self.assertFalse(any(method=="POST" for method,_,_ in self.api.calls))
        with patch("reverie.runtime.urllib.request.urlopen", side_effect=lambda *a, **kw:
                   io.BytesIO(b'{"data":[{"id":"qwen","status":{"value":"unloaded"}}]}')):
            self.assertEqual(self.runtime.check(now=1001)["backend"], "local")
        self.runtime.policy["keep_alive"]["model_id"]="wrong-model"
        with self.assertRaisesRegex(ValueError, "same local model"):
            self.runtime.local_health()

    def test_local_probe_does_not_report_secrets_or_accept_embedded_credentials(self):
        self.runtime.policy["keep_alive"]={"model_api_url":"http://user:secret@gpu/v1", "model_id":"qwen"}
        with self.assertRaisesRegex(ValueError, "without embedded credentials"):
            self.runtime.local_health()
        self.runtime.policy["keep_alive"]["model_api_url"]="http://gpu/v1"
        with patch("reverie.runtime.urllib.request.urlopen", side_effect=OSError("private connection info")):
            result=self.runtime.local_health()
        self.assertFalse(result["ready"])
        self.assertNotIn("private connection info", json.dumps(result))


class ReverieFake:
    """Just enough of Reverie's API: sessions, lifecycle, room membership and company bindings."""
    CASE = "/cases/cto"
    def __init__(self):
        self.calls=[]; self.sessions={}; self.add("old-id","cto-agent",created_at=0)
        self.resolves_parent=True; self.honors_require_agent=True
        self.lifecycle=[]; self.rooms=[{"id":"room-1","name":"general","members":[{"sessionId":"old-id","role":"agent"}]}]
        self.employees=[{"id":"emp-1","name":"cto-agent","sessionId":"old-id"}]; self.refuse=set(); self.fail_once=set()
        self.reject_once=set(); self.created=0
    def add(self, sid, name, mode="opencode", working_dir=CASE, created_at=200_000):
        self.sessions[sid]={"id":sid,"name":name,"mode":mode,"workingDir":working_dir,"pid":7,"paneExit":None,
                            "createdAt":created_at}
    def log(self, sid, event, ts): self.lifecycle.append({"ts":ts,"event":event,"sessionId":sid})
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        route=path.split("?")[0]; query=dict(urllib.parse.parse_qsl(path.split("?",1)[1])) if "?" in path else {}
        if route in self.refuse: raise urllib.error.HTTPError(path,403,"forbidden",{},None)
        if route in self.fail_once: self.fail_once.discard(route); raise urllib.error.HTTPError(path,502,"bad gateway",{},None)
        if route in self.reject_once: self.reject_once.discard(route); raise RuntimeError("Reverie rejected the operation")
        if method=="POST" and route=="/api/v1/quick-start":
            self.created+=1; sid="new-%d" % self.created; self.add(sid, body["sessionName"], body["mode"]); return {"sessionId":sid}
        if method=="GET" and route=="/api/v1/session-lifecycle":   # newest first, like Reverie's backwards read
            # `since` is deliberately ignored here: the client must not depend on the server filtering.
            entries=[e for e in self.lifecycle if e["sessionId"]==query["sessionId"]]
            return {"entries":sorted(entries,key=lambda e:-e["ts"])[:int(query["limit"])]}
        if method=="GET" and route=="/api/v1/sessions": return {"sessions":list(self.sessions.values())}
        if method=="GET" and route.startswith("/api/v1/sessions/"):
            sid=route.rsplit("/",1)[1]
            if sid not in self.sessions: raise urllib.error.HTTPError(path,404,"missing",{},None)
            return {"session":self.sessions[sid]}
        if method=="GET" and route=="/api/v1/chatrooms":
            if "member" not in query: return {"rooms":self.rooms}
            return {"rooms":[r for r in self.rooms if any(m["sessionId"]==query["member"] for m in r["members"])]}
        if method=="GET" and route.startswith("/api/v1/chatrooms/"):
            room=next((r for r in self.rooms if r["id"]==route.rsplit("/",1)[1]), None)
            if room is None: raise urllib.error.HTTPError(path,404,"missing",{},None)
            return room
        if method=="POST" and route.endswith("/members"):
            room=next(r for r in self.rooms if r["id"]==route.split("/")[4])
            room["members"].append({"sessionId":body["sessionId"],"role":"agent"}); return {}
        if method=="POST" and route.endswith("/messages"):
            # Reverie's fallback: an unresolved parent session posts AS THE USER unless refused.
            parent=os.environ.get("REVERIE_SESSION_ID")
            if parent in self.sessions and self.resolves_parent: sender={"kind":"agent","sessionId":parent}
            elif body.get("requireAgent") and self.honors_require_agent: raise urllib.error.HTTPError(path,403,"forbidden",{},None)
            else: sender={"kind":"user","name":"admin"}
            return {"message":{"from":sender,"text":body["text"]}}
        if method=="GET" and route=="/api/v1/company":
            return {"employees":self.employees, "temporaryAgents":getattr(self,"temporary",[])}
        if method=="PUT" and route.endswith("/session"):
            next(e for e in self.employees if e["id"]==route.split("/")[5])["sessionId"]=body["sessionId"]; return {}
        raise AssertionError("unexpected call %s %s" % (method,path))
    def posts(self): return [c for c in self.calls if c[0]=="POST" and c[1]=="/api/v1/quick-start"]
    def writes(self): return [c for c in self.calls if c[0]!="GET"]


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.path=self.root/"policy.json"
        self.path.write_text(json.dumps({"api_url":"http://localhost:3000","case_name":"cto","state_file":"state.json",
            "pause_file":"owner-paused","fallback":"local","max_recoveries":2,
            "backends":{"local":{"mode":"opencode","model":"local/qwen","enabled":True},
                        "cloud":{"mode":"claude","model":"configured-model","enabled":True}}}))
        self.api=ReverieFake()
        atomic_write(self.root/"state.json", {"current":"old-id","backend":"local","phase":"running","handoff":"Saved work"})
        self.cgroup=self.root/"cgroup"; self.cgroup.mkdir(); self.set_memory(used=1<<30)
        self.runtime=Runtime(self.path,self.api,cgroup=self.cgroup)

    def set_memory(self, used, limit=4<<30, inactive=0):
        (self.cgroup/"memory.max").write_text(str(limit)+"\n")
        (self.cgroup/"memory.current").write_text(str(used+inactive)+"\n")
        (self.cgroup/"memory.stat").write_text("anon %d\ninactive_file %d\n" % (used, inactive))

    def reopen(self):  # each watcher tick re-reads persisted state, as main() does
        self.runtime=Runtime(self.path,self.api,cgroup=self.cgroup); return self.runtime

    def seen_then_restarted(self):
        """Healthy at t=100 s, then a container restart logged after that (ms timestamps)."""
        self.assertTrue(self.runtime.check(now=100)["healthy"])
        del self.api.sessions["old-id"]
        self.api.log("old-id","mux_died",150_000); self.api.log("old-id","stale_cleaned",150_001)

    def test_healthy_tick_records_identity_and_bindings_for_later_restore(self):
        self.assertTrue(self.runtime.check(now=100)["healthy"])
        state=self.reopen().state
        self.assertEqual((state["current_name"],state["current_dir"],state["last_seen_at"]),("cto-agent",ReverieFake.CASE,100))
        self.assertEqual(state["bindings"]["rooms"],[{"room_id":"room-1","room":"general","role":"agent"}])
        self.assertEqual(state["bindings"]["employees"],[{"employee_id":"emp-1","name":"cto-agent"}])

    def test_clean_exit_never_respawns_even_after_the_sweep_deletes_it(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"status":0,"at":1})
        self.assertEqual(self.runtime.check(now=100)["phase"],"clean_exit")
        del self.api.sessions["old-id"]; self.api.log("old-id","deleted",200_000)
        for tick in range(3): self.assertTrue(self.reopen().check(now=200+tick)["stopped"])
        self.assertEqual(self.api.posts(),[])

    def test_signal_or_missing_status_is_not_clean(self):
        for pane_exit in ({"status":0,"signal":9,"at":1}, {"signal":9,"at":1}, {"at":1}, {"status":True,"at":1}):
            self.assertFalse(self.runtime.is_clean_exit(pane_exit), pane_exit)
        self.assertTrue(self.runtime.is_clean_exit({"status":0,"at":1}))

    def test_abnormal_exit_respawns_once_then_waits_for_verified_handoff(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})  # SIGKILL/OOM on tmux 3.2a: no status
        self.assertEqual(self.runtime.check(now=1000)["session_id"],"new-1")
        self.assertIn("do not rerun interrupted or uncertain jobs", self.reopen().state["handoff"])
        for tick in range(5): self.assertTrue(self.reopen().check(now=1001+tick)["pending"])
        self.assertEqual(len(self.api.posts()),1)

    def test_abnormal_exit_recovery_is_bounded(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"status":137,"at":1})
        for attempt in range(2):
            self.assertIn("session_id", self.reopen().check(now=1000+attempt))
            self.runtime.state.update(candidate=None, phase="running"); self.runtime.save()
        self.assertEqual(self.reopen().check(now=1010)["blocked"],"recovery budget exhausted")
        self.assertTrue(self.reopen().check(now=1011)["stopped"])  # needs_owner is sticky; no further tries
        self.assertEqual(len(self.api.posts()),2)

    def test_owner_pause_file_blocks_recovery(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})
        (self.root/"owner-paused").touch()
        self.assertEqual(self.runtime.check(now=1000),{"paused":True})
        self.assertEqual(self.api.calls,[])

    def test_owner_delete_and_unexplained_disappearance_do_not_respawn(self):
        self.assertTrue(self.runtime.check(now=100)["healthy"])
        del self.api.sessions["old-id"]
        self.assertEqual(self.reopen().check(now=200)["phase"],"missing_needs_owner")   # no evidence
        self.api.log("old-id","mux_died",150_000); self.api.log("old-id","deleted",160_000)
        self.runtime.state["phase"]="running"; self.runtime.save()
        self.assertEqual(self.reopen().check(now=201)["phase"],"owner_closed")         # delete is newest
        self.assertEqual(self.api.posts(),[])

    def test_old_restart_event_without_a_delete_cannot_revive_an_agent(self):
        self.api.log("old-id","mux_died",50_000)            # an earlier container restart, before it was seen alive
        self.assertTrue(self.runtime.check(now=100)["healthy"])
        del self.api.sessions["old-id"]                    # later deleted by a path that logged nothing
        self.assertEqual(self.reopen().check(now=200)["phase"],"missing_needs_owner")
        state=self.runtime.state; state.pop("last_seen_at"); state["phase"]="running"; self.runtime.save()
        self.api.log("old-id","mux_died",150_000)
        self.assertEqual(self.reopen().check(now=201)["phase"],"missing_needs_owner")  # never seen alive: no guess
        self.assertEqual(self.api.posts(),[])
        queries=[c[1] for c in self.api.calls if "session-lifecycle" in c[1]]
        self.assertTrue(queries and all("since=100000" in q for q in queries))   # server-side filter requested too

    def test_container_restart_recovers_and_restores_bindings_on_activation(self):
        self.seen_then_restarted()
        self.assertEqual(self.reopen().check(now=200)["session_id"],"new-1")
        self.assertEqual(self.runtime.state["recovery_reason"],"container_restart")
        result=self.reopen().activate("new-1")
        self.assertEqual(result["bindings"]["restored"],["join room general","bind employee cto-agent"])
        self.assertEqual(result["bindings"]["owner_actions"],[])
        self.assertEqual(self.api.employees[0]["sessionId"],"new-1")
        self.assertNotIn("restore_source", self.reopen().state)
        self.assertEqual(self.runtime.restore_bindings("new-1")["restored"],[])  # idempotent
        self.assertFalse(any(c[0]=="DELETE" for c in self.api.calls))

    def test_refused_binding_and_coordinators_become_owner_actions(self):
        self.api.rooms[0]["members"][0]["role"]="coordinator"                       # coordinator by role
        self.api.rooms.append({"id":"room-2","name":"Lab","members":[{"sessionId":"old-id","role":"agent"}]})
        self.api.rooms.append({"id":"room-3","name":"ops","coordinatorId":"old-id",  # coordinator only by id
                               "members":[{"sessionId":"old-id","role":"agent"}]})
        self.runtime.check(now=100)
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})
        self.api.refuse.add("/api/v1/company/employees/emp-1/session")
        self.reopen().check(now=200)
        result=self.reopen().activate("new-1")["bindings"]
        self.assertEqual(result["restored"],["join room Lab"])
        self.assertEqual(sorted(result["owner_actions"]),
                         ["bind employee cto-agent","join room general as coordinator","join room ops as coordinator"])
        self.assertFalse(any("/coordinator" in c[1] for c in self.api.calls))
        self.assertEqual(self.api.employees[0]["sessionId"],"old-id")
        self.assertIn("restore_source", self.reopen().state)   # kept until the owner's part is done

    def test_bindings_moved_by_the_owner_after_the_snapshot_are_not_taken_back(self):
        self.runtime.check(now=100)
        self.api.add("other","agent-b",mode="claude",working_dir="/cases/dm")
        self.api.employees[0]["sessionId"]="other"                     # owner rebinds emp-1 elsewhere
        self.api.rooms[0]["members"]=[]                                 # and removes the CTO from the room
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})
        self.reopen().check(now=200)
        result=self.reopen().activate("new-1")["bindings"]
        self.assertEqual(result["restored"],[])
        self.assertEqual(result["owner_actions"],["bind employee cto-agent (now bound to another session)"])
        self.assertEqual(result["skipped"],["join room general (previous runtime was removed)"])
        self.assertEqual(self.api.employees[0]["sessionId"],"other")
        self.assertEqual(self.api.rooms[0]["members"],[])

    def test_transient_restore_failure_survives_the_next_healthy_tick(self):
        self.seen_then_restarted()
        self.reopen().check(now=200)
        self.api.fail_once.add("/api/v1/company/employees/emp-1/session")
        result=self.reopen().activate("new-1")
        self.assertIn("502", result["bindings"]["error"])
        self.assertEqual(self.reopen().state["current"],"new-1")
        self.assertTrue(self.reopen().check(now=1000)["healthy"])      # snapshot now tracks new-1 ...
        self.assertEqual(self.runtime.state["bindings"]["session"],"new-1")
        self.assertEqual(self.runtime.state["restore_source"]["from"],"old-id")  # ... the frozen source does not
        self.assertEqual(self.reopen().restore_bindings("new-1")["restored"],["bind employee cto-agent"])
        self.assertEqual(self.api.employees[0]["sessionId"],"new-1")

    def test_planned_switch_snapshots_previous_inside_activate(self):
        self.runtime.start("cloud","Planned handoff")                 # no watcher tick ever ran
        self.assertNotIn("bindings", self.runtime.state)
        result=self.reopen().activate("new-1")["bindings"]
        self.assertEqual(result["restored"],["join room general","bind employee cto-agent"])
        self.assertEqual(self.reopen().state["backend"],"cloud")
        self.api.rooms[0]["members"]=[]; self.api.employees[0]["sessionId"]="nobody-else"
        self.runtime.start("local","Next handoff")
        self.api.employees[0]["sessionId"]="x"
        result=self.reopen().activate("new-2")["bindings"]
        self.assertEqual(result["note"],"no binding snapshot of the previous runtime")

    def test_live_session_recovered_by_hand_is_adopted_with_its_own_backend(self):
        self.seen_then_restarted()
        self.api.add("manual","CTO · local",created_at=160_000)
        result=self.reopen().check(now=200)
        self.assertEqual((result["adopted"],result["backend"]),("manual","local"))
        self.assertEqual(self.runtime.state["candidate_backend"],"local")
        self.assertTrue(self.reopen().check(now=201)["pending"])
        self.assertEqual(self.api.posts(),[])

    def test_adoption_ignores_nameless_previous_earlier_and_other_case_sessions(self):
        self.seen_then_restarted()
        self.api.add("nameless",None)
        self.api.add("stale-previous","CTO · local"); self.api.add("earlier","cto-agent")
        self.api.add("elsewhere","cto-agent",working_dir="/cases/other")
        self.api.add("coordinator","coordinator",mode="claude")                    # same case, different identity
        state=self.runtime.state; state.update(previous="stale-previous", candidates_seen=["earlier"]); self.runtime.save()
        self.assertEqual(self.reopen().check(now=200)["session_id"],"new-1")   # nothing adoptable: create one

    def test_adoption_without_a_recorded_directory_requires_the_policy_case(self):
        self.seen_then_restarted()
        state=self.runtime.state; state.pop("current_dir"); self.runtime.save()     # state from an older watcher
        self.api.add("elsewhere","cto-agent",working_dir="/cases/other")
        self.assertEqual(self.reopen().check(now=200)["session_id"],"new-1")
        self.runtime.state.update(candidate=None, current="new-1", phase="running"); self.runtime.save()
        self.api.sessions.pop("new-1"); self.api.log("new-1","stale_cleaned",400_000)
        self.runtime.state.update(last_seen_at=300); self.runtime.save()
        self.api.add("same-case","cto-agent",working_dir="/elsewhere/cto",created_at=400_000)
        self.assertEqual(self.reopen().check(now=500)["adopted"],"same-case")

    def test_several_matching_sessions_stop_for_the_owner(self):
        self.seen_then_restarted()
        self.api.add("a","cto-agent"); self.api.add("b","CTO · local")
        result=self.reopen().check(now=200)
        self.assertEqual(result["blocked"],"several live sessions carry the configured agent identity")
        self.assertEqual(sorted(result["sessions"]),["a","b"])
        self.assertTrue(self.reopen().check(now=201)["stopped"])
        self.assertEqual(self.api.posts(),[])

    def test_unverifiable_identity_claims_stop_for_the_owner_instead_of_duplicating(self):
        cases={"odd":dict(name="cto-agent",mode="codex"),                       # unknown adapter
               "coordinator":dict(name="cto-agent",mode="claude"),                     # coordinator renamed, same cwd
               "renamed":dict(name="CTO · local",created_at=50_000)}       # existed while the CTO was alive
        for sid,spec in cases.items():
            with self.subTest(sid):
                self.setUp(); self.seen_then_restarted()
                self.api.add(sid,**spec)
                result=self.reopen().check(now=200)
                self.assertEqual(result["blocked"],"live session with the configured agent identity cannot be verified")
                self.assertEqual((result["sessions"],self.api.posts()),([sid],[]))

    def test_watcher_never_adopts_its_own_session(self):
        self.seen_then_restarted()
        self.api.add("watcher","cto-agent")
        with patch.dict(os.environ, {"REVERIE_SESSION_ID":"watcher"}):
            self.assertEqual(self.reopen().check(now=200)["session_id"],"new-1")

    def test_dead_adopted_candidate_alerts_once_and_spawns_nothing(self):
        self.seen_then_restarted()
        self.api.add("manual","cto-agent")
        self.reopen().check(now=200)
        del self.api.sessions["manual"]
        self.enable_alerts()
        with patch.dict("os.environ", {"REVERIE_SESSION_ID":"watcher"}):
            result=self.reopen().check(now=300)
        self.assertEqual(result["candidate"],"manual"); self.assertEqual(result["posted"],"room-1")
        posted=[c for c in self.api.calls if c[1].endswith("/messages")]
        self.assertEqual(len(posted),1); self.assertIn("died before activation", posted[0][2]["text"])
        self.assertEqual(self.reopen().check(now=301)["phase"],"candidate_failed")
        self.assertEqual(self.api.posts(),[])

    def enable_alerts(self, member=True):
        policy=json.loads(self.path.read_text()); policy["alert_room"]="room-1"; self.path.write_text(json.dumps(policy))
        self.api.add("watcher","reverie-runtime watcher",mode="shell")
        if member: self.api.rooms[0]["members"].append({"sessionId":"watcher","role":"agent"})

    def test_alert_is_never_posted_as_the_user(self):
        self.enable_alerts()
        scenarios={"no identity":{}, "inherits the CTO id":{"REVERIE_SESSION_ID":"old-id"},
                   "unknown to Reverie":{"REVERIE_SESSION_ID":"ghost"}}
        for label,env in scenarios.items():
            with self.subTest(label), patch.dict(os.environ, env):
                os.environ.pop("REVERIE_SESSION_ID", None) if not env else None
                result=self.reopen().alert("recovery stopped")
                self.assertNotIn("posted", result); self.assertIn("undelivered", result)
                self.assertEqual([c for c in self.api.writes() if c[1].endswith("/messages")],[])
        self.assertEqual(len(self.reopen().state["undelivered_alerts"]),3)   # R5: kept for the owner

    def test_alert_requires_room_membership_and_flags_a_server_fallback(self):
        self.enable_alerts(member=False)
        with patch.dict(os.environ, {"REVERIE_SESSION_ID":"watcher"}):
            self.assertEqual(self.reopen().alert("x")["undelivered"],"watcher is not a member of the alert room")
            self.api.rooms[0]["members"].append({"sessionId":"watcher","role":"agent"})
            self.api.resolves_parent=False                      # e.g. session owned by another user
            self.assertEqual(self.reopen().alert("x")["undelivered"][:12],"post failed:")   # requireAgent refused
            self.api.honors_require_agent=False                 # an old server that would fall back
            result=self.reopen().alert("x")
            self.assertTrue(result["undelivered"].startswith("MISATTRIBUTED"))
            self.api.resolves_parent=True
            self.assertEqual(self.reopen().alert("x")["posted"],"room-1")
        posted=[c[2] for c in self.api.calls if c[1].endswith("/messages")]
        self.assertTrue(all(body["requireAgent"] is True for body in posted))

    def test_failed_planned_switch_keeps_supervising_the_healthy_runtime(self):
        self.assertTrue(self.runtime.check(now=100)["healthy"])
        self.runtime.start("cloud","Planned handoff")
        del self.api.sessions["new-1"]
        result=self.reopen().check(now=200)
        self.assertEqual(result["candidate"],"new-1"); self.assertIn("still supervising", result["alert"])
        self.assertTrue(self.reopen().check(now=201)["healthy"])
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})
        self.assertEqual(self.reopen().check(now=300)["session_id"],"new-2")  # and still recovers it

    def test_reset_never_orphans_a_live_candidate(self):
        self.runtime.start("local","Planned handoff")                  # new-1 is live and pending
        with self.assertRaisesRegex(ValueError,"still live"): self.reopen().reset()
        self.assertEqual(self.reopen().state["candidate"],"new-1")
        self.api.sessions["new-1"]["paneExit"]={"at":1}                # once it has exited, reset may clear it
        self.assertEqual(self.reopen().reset()["reset"]["candidate"],"new-1")
        self.assertIsNone(self.reopen().state["candidate"])

    def test_reset_keeps_the_recovery_budget(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"status":137,"at":1})
        for attempt in range(2):
            self.reopen().check(now=1000+attempt)
            self.api.sessions["new-%d" % (attempt+1)]["paneExit"]={"at":1}
            self.reopen().check(now=1000+attempt)                       # candidate died: needs the owner
            self.reopen().reset()
        self.assertEqual(len(self.reopen().state["recovery_attempts"]),2)
        self.assertEqual(self.reopen().check(now=1010)["blocked"],"recovery budget exhausted")
        self.assertEqual(len(self.api.posts()),2)

    def test_owner_reset_resumes_supervision_but_respects_uncertain_creation(self):
        self.runtime.state.update(phase="needs_owner"); self.runtime.save()
        self.assertTrue(self.reopen().check(now=100)["stopped"])
        self.assertEqual(self.reopen().reset()["reset"]["phase"],"needs_owner")
        self.assertTrue(self.reopen().check(now=101)["healthy"])
        self.runtime.state.update(creation_uncertain=True); self.runtime.save()
        with self.assertRaisesRegex(ValueError,"inspect Reverie"): self.reopen().reset()
        self.assertFalse(self.reopen().reset(creation_inspected=True)["current"] is None)

    def test_reverie_rejection_during_restore_is_returned_not_raised(self):
        self.seen_then_restarted()
        self.reopen().check(now=200)
        self.api.reject_once.add("/api/v1/company/employees/emp-1/session")   # Reverie success:false
        result=self.reopen().activate("new-1")
        self.assertIn("rejected", result["bindings"]["error"])
        self.assertEqual(self.reopen().state["current"],"new-1")
        self.assertEqual(self.reopen().restore_bindings("new-1")["restored"],["bind employee cto-agent"])

    def test_identity_report_finds_stale_bindings_read_only(self):
        self.seen_then_restarted()                                  # tracked runtime gone after a recreate
        self.api.add("fresh","cto-agent",created_at=160_000)        # the relaunched runtime, same identity
        self.api.employees[0]["sessionId"]="long-gone"              # company still bound to an older session
        self.api.temporary=[{"sessionId":"fresh"},{"sessionId":"dead-1"},{"sessionId":"dead-2"}]
        self.api.rooms=[{"id":"room-1","name":"Office","members":[{"sessionId":"old-id","name":"cto-agent","role":"agent"}]},
                        {"id":"room-2","name":"Lead","members":[{"sessionId":"gone-lead","name":"ghost","role":"coordinator"}]}]
        before=len(self.api.calls)
        report=self.reopen().identity_report()
        kinds=[f["kind"] for f in report["findings"]]
        self.assertEqual(kinds,["runtime_not_tracked","employee_unbound","temporary_agents_stale","room_member_dead","room_member_dead"])
        self.assertEqual(report["findings"][0]["adoptable"],["fresh"])
        self.assertEqual(report["findings"][2]["count"],2)
        self.assertEqual(report["findings"][4]["live_same_name"],[])    # no lead for an unknown name
        actions=report["owner_actions"]
        self.assertIn("reverie-runtime activate fresh", actions[0]["action"])
        self.assertEqual(actions[1],{"authority":"owner","method":"PUT","path":"/api/v1/company/employees/emp-1/session",
                                     "body":{"sessionId":"fresh"}})
        self.assertEqual(actions[2]["path"],"/api/v1/chatrooms/room-1/members")
        self.assertEqual(len(actions),3)
        self.assertTrue(all(c[0]=="GET" for c in self.api.calls[before:]))   # read-only
        self.assertEqual(self.reopen().state["current"],"old-id")             # state untouched

    def test_identity_report_encodes_ids_and_cli_reports_errors_without_traceback(self):
        from reverie.runtime import main
        self.seen_then_restarted()
        self.api.add("fresh","cto-agent",created_at=160_000)
        self.api.employees[0].update(id="emp/1?x", sessionId="long-gone")
        self.api.rooms=[{"id":"room 1/a","name":"Office","members":[{"sessionId":"old-id","name":"cto-agent","role":"agent"}]}]
        actions=self.reopen().identity_report()["owner_actions"]
        self.assertEqual(actions[1]["path"],"/api/v1/company/employees/emp%2F1%3Fx/session")
        self.assertEqual(actions[2]["path"],"/api/v1/chatrooms/room%201%2Fa/members")
        class Down:
            def call(self, *a, **k): raise OSError("connection refused")
        with patch("reverie.runtime.Reverie", return_value=Down()), patch("sys.stdout", new=io.StringIO()) as out:
            self.assertEqual(main(["--policy",str(self.path),"identity"]),0)
        self.assertEqual(json.loads(out.getvalue()),{"error":"connection refused"})

    def write_instance(self, path, name, persona):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"id":name.lower(),"agent_name":name,"owner_name":"Owner","data_dir":"state-"+name.lower(),
                                    "persona":persona,"role":"Planner","kind":"expert"}))
        return path

    def test_profile_reports_backend_bindings_and_persona_of_the_supervised_runtime_read_only(self):
        workspace=self.root/"workspace"; workspace.mkdir()
        instance=self.write_instance(self.root/"config"/"alpha.json","Alpha","Calm and exact. "*200)
        (workspace/".reverie-instance").write_text(json.dumps({"instance":str(instance)}))
        policy=json.loads(self.path.read_text()); policy["instances_dir"]="config"; self.path.write_text(json.dumps(policy))
        self.api.sessions["old-id"].update(workingDir=str(workspace), model="local/qwen", pinned=True, status="idle",
                                           tokens={"input":30,"output":20,"total":50}, totalCost=0, messageCount=4)
        self.api.employees[0].update(icon="*", position="Planner", expertise=["planning"])
        before=len(self.api.calls)
        profile=self.reopen().profile("old-id")
        self.assertEqual(profile["session"]["name"],"cto-agent")
        self.assertTrue(profile["session"]["alive"]); self.assertTrue(profile["session"]["pinned"])
        self.assertEqual(profile["backend"],{"mode":"opencode","model":"local/qwen","display_model":None})
        self.assertEqual(profile["effort"],{"configured":None,"observed":None})      # no transcript for OpenCode
        self.assertEqual((profile["usage"]["input_tokens"],profile["usage"]["total_tokens"],profile["usage"]["messages"]),(30,50,4))
        self.assertEqual(profile["employee"],{"id":"emp-1","name":"cto-agent","icon":"*","position":"Planner","expertise":["planning"]})
        self.assertEqual(profile["rooms"],[{"id":"room-1","name":"general","role":"agent"}])
        runtime=profile["runtime"]
        self.assertTrue(runtime["supervised"]); self.assertEqual((runtime["backend"],runtime["phase"]),("local","running"))
        self.assertEqual([b["name"] for b in runtime["backends"]],["local","cloud"])
        self.assertFalse(runtime["switch"]["available"])
        self.assertEqual(profile["persona"]["agent_name"],"Alpha"); self.assertEqual(profile["persona"]["role"],"Planner")
        self.assertEqual(len(profile["persona"]["persona"]),2000)                    # bounded
        self.assertTrue(all(c[0]=="GET" for c in self.api.calls[before:]))            # read-only
        self.assertEqual(self.reopen().state,{"current":"old-id","backend":"local","phase":"running","handoff":"Saved work"})
        # The agent writes its own marker: one naming a file outside the instances dir is ignored.
        outside=self.write_instance(self.root/"elsewhere"/"evil.json","Mallory","x")
        (workspace/".reverie-instance").write_text(json.dumps({"instance":str(outside)}))
        self.assertIsNone(self.reopen().profile("old-id")["persona"])
        (workspace/".reverie-instance").write_text(json.dumps({"instance":str(self.root/"config"/"broken.json")}))
        (self.root/"config"/"broken.json").write_text('{"secret": "do not echo"}')
        self.assertEqual(self.reopen().profile("old-id")["persona"]["error"],"instance config unreadable")
        # Direct-message rooms are left out for a non-owner caller.
        self.api.rooms.append({"id":"dm-1","name":"","kind":"dm","members":[{"sessionId":"old-id","role":"agent"}]})
        self.assertEqual([r["id"] for r in self.reopen().profile("old-id")["rooms"]],["room-1","dm-1"])
        self.assertEqual([r["id"] for r in self.reopen().profile("old-id",include_dms=False)["rooms"]],["room-1"])

    def test_profile_reads_claude_effort_from_its_transcript_and_persona_from_the_policy_only(self):
        workspace=self.root/"workspace"; workspace.mkdir()
        (workspace/".reverie-instance").write_text(json.dumps({"instance":str(self.write_instance(self.root/"config"/"alpha.json","Alpha","A"))}))
        conversation="00000004-0004-4000-8000-000000000004"
        self.api.add("lead","lead-agent",mode="claude",working_dir=str(workspace))  # shares the runtime's workspace
        self.api.sessions["lead"].update(claudeSessionChain=["00000005-0005-4000-8000-000000000005",conversation],
                                         displayModel={"model":"Big Model"})
        projects=self.root/"claude"/"projects"/"some-slug"; projects.mkdir(parents=True)
        (projects/(conversation+".jsonl")).write_text("\n".join([
            json.dumps({"type":"assistant","effort":"low","timestamp":"t1"}),
            json.dumps({"type":"assistant","effort":"high","timestamp":"t2"}),
            "{not json", json.dumps({"type":"user","message":{"content":"hi"}})])+"\n")
        policy=json.loads(self.path.read_text()); policy.update(instances_dir="config", agent_instances={"lead":"config/beta.json"})
        self.path.write_text(json.dumps(policy)); self.write_instance(self.root/"config"/"beta.json","Beta","Curious.")
        with patch.dict(os.environ,{"CLAUDE_CONFIG_DIR":str(self.root/"claude")}):
            profile=self.reopen().profile("lead")
        self.assertEqual(profile["effort"]["observed"],{"level":"high","at":"t2"})   # newest record that names one
        self.assertEqual(profile["backend"]["model"],"Big Model")
        self.assertFalse(profile["runtime"]["supervised"]); self.assertEqual(profile["runtime"]["backends"],[])
        # A shared working dir is not identity: the runtime's marker is ignored, the policy's map is used.
        self.assertEqual(profile["persona"]["agent_name"],"Beta")
        self.assertEqual(profile["employee"],None); self.assertEqual(profile["rooms"],[])
        policy["agent_instances"]={}; self.path.write_text(json.dumps(policy))
        self.assertIsNone(self.reopen().profile("lead")["persona"])
        # A conversation id is never used as a path: this file is reachable only by traversal.
        (self.root/"claude"/"projects"/"outside.jsonl").write_text(json.dumps({"effort":"max"})+"\n")
        self.api.sessions["lead"]["claudeSessionChain"]=["../outside"]
        with patch.dict(os.environ,{"CLAUDE_CONFIG_DIR":str(self.root/"claude")}):
            self.assertIsNone(self.reopen().profile("lead")["effort"]["observed"])

    def finishes(self, call, timeout=5.0):
        import threading
        result = {}
        worker = threading.Thread(target=lambda: result.setdefault("value", call()), daemon=True)
        worker.start(); worker.join(timeout)
        self.assertFalse(worker.is_alive(), "blocked on an agent-writable path")
        return result["value"]

    def test_profile_marker_is_a_small_regular_file_naming_a_config_strictly_inside_the_instances_dir(self):
        workspace=self.root/"workspace"; workspace.mkdir()
        self.write_instance(self.root/"config"/"alpha.json","Alpha","A")
        policy=json.loads(self.path.read_text()); policy["instances_dir"]="config"; self.path.write_text(json.dumps(policy))
        self.api.sessions["old-id"].update(workingDir=str(workspace))
        marker=workspace/".reverie-instance"
        persona=lambda: self.finishes(lambda: self.reopen().profile("old-id")["persona"])
        marker.write_text(json.dumps({"instance":"../config/alpha.json"}))          # relative to the workspace
        self.assertEqual(persona()["agent_name"],"Alpha")
        with patch("os.getcwd", return_value=str(self.root/"elsewhere")):
            self.assertEqual(persona()["agent_name"],"Alpha")
        self.write_instance(self.root/"elsewhere"/"evil.json","Mallory","x")
        marker.write_text(json.dumps({"instance":str(self.root/"config"/".."/"elsewhere"/"evil.json")}))
        self.assertIsNone(persona())                                                  # resolved before the check
        self.write_instance(self.root/"config-evil"/"x.json","Mallory","x")
        marker.write_text(json.dumps({"instance":str(self.root/"config-evil"/"x.json")}))
        self.assertIsNone(persona())                                                  # a path, not a string prefix
        marker.write_text(json.dumps({"instance":str(self.root/"config"/"alpha.json")})+" "*5000)
        self.assertIsNone(persona())                                                  # larger than a marker
        marker.unlink(); marker.symlink_to("/dev/zero")
        self.assertIsNone(persona())
        good=workspace/"good-marker"; good.write_text(json.dumps({"instance":"../config/alpha.json"}))
        marker.unlink(); marker.symlink_to(good)
        self.assertIsNone(persona())                                                  # never followed
        marker.unlink(); os.mkfifo(marker)
        self.assertIsNone(persona())                                                  # no writer: must not block
        writer=os.open(marker, os.O_RDWR | os.O_NONBLOCK)                             # a FIFO already holding a marker
        try:
            os.write(writer, json.dumps({"instance":"../config/alpha.json"}).encode())
            self.assertIsNone(persona())
        finally: os.close(writer)

    def test_profile_policy_map_is_confined_to_the_instances_dir_and_read_bounded(self):
        # Agents run as the policy's owner and could edit their own map entry: it gets the marker's confinement.
        self.api.add("lead","lead-agent",mode="claude",working_dir=str(self.root))
        self.write_instance(self.root/"config"/"beta.json","Beta","Curious.")
        secret=self.root/"home"/".claude"/".credentials.json"; secret.parent.mkdir(parents=True)
        secret.write_text(json.dumps({"id":"x","agent_name":"Leak","owner_name":"o","data_dir":"../state","persona":"TOKEN"}))
        def persona(entry, instances_dir="config"):
            policy=json.loads(self.path.read_text()); policy["agent_instances"]={"lead":entry}
            policy.pop("instances_dir",None)
            if instances_dir: policy["instances_dir"]=instances_dir
            self.path.write_text(json.dumps(policy))
            return self.finishes(lambda: self.reopen().profile("lead")["persona"])
        self.assertEqual(persona("config/beta.json")["agent_name"],"Beta")
        self.assertIsNone(persona("config/beta.json", instances_dir=None))           # no root: fail closed
        self.assertIsNone(persona(str(secret)))                                       # outside, absolute
        self.assertIsNone(persona("config/../home/.claude/.credentials.json"))        # resolved before the check
        with patch.dict(os.environ,{"HOME":str(self.root/"home")}):
            self.assertIsNone(persona("~/.claude/.credentials.json"))
        self.write_instance(self.root/"config-evil"/"x.json","Mallory","x")
        self.assertIsNone(persona(str(self.root/"config-evil"/"x.json")))            # a path, not a string prefix
        self.assertIsNone(persona("config"))                                          # the root itself
        (self.root/"config"/"link.json").symlink_to(secret)
        self.assertIsNone(persona("config/link.json"))                               # a link out is resolved first
        (self.root/"config"/"zero.json").symlink_to("/dev/zero")
        self.assertIsNone(persona("config/zero.json"))
        os.mkfifo(self.root/"config"/"fifo.json")
        self.assertEqual(persona("config/fifo.json")["error"],"instance config unreadable")   # never blocks
        big=self.write_instance(self.root/"config"/"big.json","Big","x")
        big.write_text(big.read_text()+" "*(64*1024))
        self.assertEqual(persona("config/big.json")["error"],"instance config unreadable")    # refused, not truncated
        self.assertEqual(persona("config/beta.json")["persona"],"Curious.")

    def test_profile_effort_reads_only_a_bounded_tail_of_a_regular_transcript(self):
        from reverie.runtime import observed_effort
        conversation="00000004-0004-4000-8000-000000000004"
        projects=self.root/"projects"; (projects/"slug").mkdir(parents=True)
        transcript=projects/"slug"/(conversation+".jsonl")
        filler=(json.dumps({"type":"user","message":{"content":"x"*1000}})+"\n")*700  # ~700 KiB, past the tail
        transcript.write_text(json.dumps({"effort":"low","timestamp":"t1"})+"\n"+filler)
        self.assertIsNone(observed_effort(conversation, projects))                   # outside the tail
        transcript.write_text(json.dumps({"effort":"low","timestamp":"t1"})+"\n"+filler
                              +json.dumps({"effort":"high","timestamp":"t2"})+"\n")
        self.assertEqual(observed_effort(conversation, projects),{"level":"high","at":"t2"})
        transcript.write_text("\n".join([json.dumps({"effort":"medium","timestamp":"t0"}),
                                         json.dumps({"effort":"xhigh","timestamp":"t"*65}),
                                         json.dumps({"effort":"<b>max</b>","timestamp":"t1"})])+"\n")
        self.assertEqual(observed_effort(conversation, projects),{"level":"xhigh","at":None})  # validated
        transcript.write_text(json.dumps({"effort":"max","timestamp":["t"]})+"\n")
        self.assertEqual(observed_effort(conversation, projects),{"level":"max","at":None})
        transcript.unlink(); transcript.symlink_to("/dev/zero")
        self.assertIsNone(self.finishes(lambda: observed_effort(conversation, projects)))
        transcript.unlink(); os.mkfifo(transcript)
        self.assertIsNone(self.finishes(lambda: observed_effort(conversation, projects)))
        writer=os.open(transcript, os.O_RDWR | os.O_NONBLOCK)
        try:
            os.write(writer, (json.dumps({"effort":"high","timestamp":"t"})+"\n").encode())
            self.assertIsNone(self.finishes(lambda: observed_effort(conversation, projects)))
        finally: os.close(writer)

    def test_profile_cli_no_dms_leaves_out_direct_message_rooms(self):
        from reverie.runtime import main
        self.api.rooms.append({"id":"dm-1","name":"","kind":"dm","members":[{"sessionId":"old-id","role":"agent"}]})
        def rooms(*args):
            with patch("reverie.runtime.Reverie", return_value=self.api), patch("sys.stdout", new=io.StringIO()) as out:
                self.assertEqual(main(["--policy",str(self.path),"profile","old-id",*args]),0)
            return [r["id"] for r in json.loads(out.getvalue())["rooms"]]
        self.assertEqual(rooms(),["room-1","dm-1"])
        self.assertEqual(rooms("--no-dms"),["room-1"])

    def test_profile_cli_reports_unknown_and_invalid_ids_and_never_takes_the_watcher_lock(self):
        from reverie.runtime import main
        def run(*args):
            with patch("reverie.runtime.Reverie", return_value=self.api), patch("sys.stdout", new=io.StringIO()) as out:
                code=main(["--policy",str(self.path),"profile",*args])
            return code, json.loads(out.getvalue())
        with (self.root/"state.lock").open("a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)                          # a watcher tick in progress
            code, result = run("old-id")
            self.assertEqual(code,0); self.assertEqual(result["session"]["id"],"old-id")
        self.assertEqual(run("missing"),(1,{"error":"no such session","status":404}))
        self.assertEqual(run("../old-id"),(1,{"error":"invalid session id"}))

    def test_dialog_needs_attention_without_input_or_respawn(self):
        self.api.sessions["old-id"]["paneDialog"]="Allow this command? (y/n)"
        self.assertTrue(self.runtime.check(now=100)["needs_attention"])
        self.assertEqual(self.api.writes(),[])

    def test_memory_admission_blocks_recovery_without_spending_an_attempt(self):
        self.api.sessions["old-id"].update(pid=None, paneExit={"at":1})
        self.set_memory(used=3400<<20)          # today's level: 3.4 GiB of 4 GiB
        result=self.runtime.check(now=1000)
        self.assertEqual(result["blocked"],"memory admission refused")
        self.assertNotIn("recovery_attempts", self.reopen().state)
        self.assertEqual(self.api.posts(),[])
        self.set_memory(used=2400<<20, inactive=1000<<20)  # reclaimable cache does not count
        self.assertEqual(self.reopen().check(now=1001)["session_id"],"new-1")

    def test_manual_switch_is_refused_when_memory_is_short(self):
        self.set_memory(used=3400<<20)
        with self.assertRaisesRegex(ValueError,"memory admission refused"):
            self.runtime.start("local","handoff")
        self.assertEqual(self.api.posts(),[])
        self.assertFalse(self.reopen().state.get("creation_uncertain"))


class AdmissionTests(unittest.TestCase):
    def test_sizes_limits_and_unlimited_cgroup(self):
        from reverie.admission import admit, parse_size, session_admission
        self.assertEqual(parse_size("1.5G"), 3<<29); self.assertEqual(parse_size("512M"), 512<<20)
        with tempfile.TemporaryDirectory() as name:
            cgroup=Path(name)
            self.assertTrue(admit(10<<30, cgroup=cgroup)["admitted"])   # unreadable: no limit known
            (cgroup/"memory.max").write_text("max\n"); (cgroup/"memory.current").write_text("1\n")
            (cgroup/"memory.stat").write_text("inactive_file 0\n")
            self.assertTrue(admit(10<<30, cgroup=cgroup)["admitted"])
            (cgroup/"memory.max").write_text(str(4<<30)); (cgroup/"memory.current").write_text(str(3<<30))
            self.assertFalse(admit(600<<20, cgroup=cgroup)["admitted"])
            self.assertTrue(admit(400<<20, cgroup=cgroup)["admitted"])
            self.assertTrue(session_admission({}, "claude", cgroup)["admitted"])
            self.assertFalse(session_admission({}, "opencode", cgroup)["admitted"])
            policy={"memory_admission":{"session_cost_bytes":{"opencode":100<<20}}}
            self.assertTrue(session_admission(policy, "opencode", cgroup)["admitted"])

    def test_cli_refuses_with_tempfail(self):
        from reverie import admission
        with patch.object(admission, "admit", return_value={"admitted":False,"reason":"short"}):
            self.assertEqual(admission.main(["--expect","1G","--","true"]), admission.EX_TEMPFAIL)


class WatchLoopTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.path=self.root/"policy.json"
        self.write_policy()

    def write_policy(self, **keep_alive):
        self.path.write_text(json.dumps({"api_url":"http://localhost:3000","case_name":"cto","state_file":"state.json",
            "pause_file":"paused","fallback":"local","keep_alive":dict({"model_api_url":"http://gpu/v1","model_id":"qwen",
            "poll_seconds":10},**keep_alive),"backends":{"local":{"mode":"opencode","model":"local/qwen","enabled":True}}}))

    def run_watch(self, step, ticks, alarms=None):
        from reverie.runtime import watch
        lines=[]
        watch(self.path, step, ticks=ticks, sleep=lambda s: None, out=lambda line, flush=True: lines.append(line),
              alarm=(alarms.append if alarms is not None else (lambda s: None)))
        return lines

    def test_failing_ticks_are_ticking_but_not_healthy(self):
        from reverie.runtime import watcher_health
        runtime=Runtime(self.path, FakeAPI())
        self.assertEqual(watcher_health(runtime)["reason"],"no heartbeat yet")
        def failing(): raise RuntimeError("Reverie down during container start")
        lines=self.run_watch(failing, ticks=2)
        health=watcher_health(runtime)
        self.assertEqual((health["ticking"],health["healthy"],health["consecutive_errors"]),(True,False,2))
        self.assertIn("Reverie down", health["last_error"])
        self.assertEqual(len(lines),1)                                  # unchanged results print once
        self.run_watch(lambda: {"healthy":True}, ticks=1)
        health=watcher_health(runtime)
        self.assertEqual((health["healthy"],health["consecutive_errors"]),(True,0))
        self.run_watch(failing, ticks=1)                                # a recent success, then a failure
        health=watcher_health(runtime)
        self.assertEqual((health["ticking"],health["healthy"],health["consecutive_errors"]),(True,False,1))
        self.assertLess(health["last_ok_age_seconds"], 5)
        self.assertFalse(watcher_health(runtime, now=time.time()+61)["ticking"])   # 3*10+30 s limit

    def test_bad_policy_is_a_failed_tick_not_a_crash(self):
        from reverie.runtime import watcher_health
        calls=[]
        def step():
            calls.append(1)
            if len(calls)==1: self.write_policy(poll_seconds=0)        # owner saves a broken policy
            return {"healthy":True}
        self.run_watch(step, ticks=3)
        self.write_policy()                                             # the owner fixes it
        health=watcher_health(Runtime(self.path, FakeAPI()))
        self.assertEqual(len(calls),1)                                  # later ticks fail on the policy, loop survives
        self.assertEqual(health["consecutive_errors"],2)
        self.assertIn("poll interval", health["last_error"])

    def test_every_tick_is_bounded_by_an_alarm_and_cleared(self):
        alarms=[]
        self.write_policy(tick_timeout_seconds=120)
        self.run_watch(lambda: {"healthy":True}, ticks=2, alarms=alarms)
        self.assertEqual(alarms,[300,120,0,120,120,0])

    def test_a_hung_tick_kills_the_watcher_and_frees_the_lock(self):
        self.write_policy(tick_timeout_seconds=2)
        script=("import sys,time; sys.path.insert(0,%r); from reverie.runtime import watch; "
                "watch(%r, lambda: time.sleep(60), sleep=lambda s: None)" % (str(Path.cwd()), str(self.path)))
        started=time.monotonic()
        code=subprocess.run([sys.executable,"-c",script],timeout=30).returncode
        self.assertLess(time.monotonic()-started, 15)
        self.assertEqual(code, -signal.SIGALRM)
        with (self.root/"state.watch.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)            # free: a standby would take over

    def test_second_watcher_waits_as_standby_and_takes_over(self):
        import threading
        from reverie.runtime import watch
        held=(self.root/"state.watch.lock").open("a"); fcntl.flock(held, fcntl.LOCK_EX)
        ran=[]; lines=[]
        standby=threading.Thread(target=watch, args=(self.path, lambda: ran.append(1) or {"ok":True}),
                                 kwargs=dict(ticks=1, sleep=lambda s: None, out=lambda l, flush=True: lines.append(l),
                                             alarm=lambda s: None))
        standby.start(); time.sleep(0.3)
        self.assertEqual(ran,[])                                        # never two active watchers
        self.assertIn("standby", lines[0])
        fcntl.flock(held, fcntl.LOCK_UN); held.close()                   # the active one dies
        standby.join(5)
        self.assertEqual(ran,[1])
        self.assertEqual((self.root/"state.watch.lock").read_text(), str(os.getpid()))

    def test_stop_watcher_ends_active_and_standby_watchers_of_this_policy_only(self):
        from reverie.runtime import stop_watchers
        proc=self.root/"proc"
        def fake(pid, *argv):
            (proc/str(pid)).mkdir(parents=True); (proc/str(pid)/"cmdline").write_bytes(b"\0".join(a.encode() for a in argv)+b"\0")
        fake(101,"/opt/reverie/python/bin/python3","/opt/reverie/python/bin/reverie-runtime","--policy",str(self.path),"watch")
        fake(102,"python3","-m","reverie.runtime","--policy",str(self.path),"watch")
        fake(103,"python3","/x/reverie-runtime","--policy",str(self.root/"other.json"),"watch")
        fake(104,"python3","/x/reverie-runtime","--policy",str(self.path),"status")
        fake(105,"bash","-c","echo watch")
        sent=[]
        result=stop_watchers(self.path, proc=proc, kill=lambda pid, sig: sent.append((pid, sig)), wait=lambda s: None)
        self.assertEqual(result["terminated"],[101,102])
        self.assertEqual(result["killed"],[101,102])                    # still listed after the grace period
        self.assertEqual(sent,[(101,signal.SIGTERM),(102,signal.SIGTERM),(101,signal.SIGKILL),(102,signal.SIGKILL)])

    def test_only_real_watcher_command_lines_match(self):
        from reverie.runtime import is_watcher_argv
        p="/instances/p.json"
        for argv in (["/opt/reverie/python/bin/python3","/opt/reverie/python/bin/reverie-runtime","--policy",p,"watch"],
                     ["python3","-m","reverie.runtime","--policy",p,"watch"], ["/usr/bin/reverie-runtime","--policy",p,"watch"]):
            self.assertTrue(is_watcher_argv(argv), argv)
        for argv in (["watch","-n5","reverie-runtime","--policy",p,"status"],          # procps watch
                     ["watch","reverie-runtime","--policy",p,"watch"],
                     ["python3","/x/reverie-runtime","--policy",p,"watch","--help"],
                     ["bash","-c","reverie-runtime --policy %s watch" % p],
                     ["python3","-c","import reverie.runtime","--policy",p,"watch"], ["watch"]):
            self.assertFalse(is_watcher_argv(argv), argv)

    def test_a_tick_killed_by_the_alarm_is_reported_by_the_next_watcher(self):
        from reverie.runtime import heartbeat_path, watcher_health
        self.write_policy(tick_timeout_seconds=2)
        script=("import sys,time; sys.path.insert(0,%r); from reverie.runtime import watch; "
                "watch(%r, lambda: time.sleep(60), sleep=lambda s: None)" % (str(Path.cwd()), str(self.path)))
        subprocess.run([sys.executable,"-c",script],timeout=30)
        runtime=Runtime(self.path, FakeAPI())
        self.assertGreaterEqual(watcher_health(runtime)["running_tick_seconds"], 1)   # visible while dead
        self.run_watch(lambda: {"healthy":True}, ticks=0)                  # a new watcher takes the lock
        health=watcher_health(runtime)
        self.assertIn("died", health["last_error"]); self.assertIn("probable tick timeout", health["last_error"])
        self.assertEqual((health["consecutive_errors"], health["running_tick_seconds"], health["healthy"]), (1, None, False))
        def still_slow(): raise RuntimeError("still slow")
        self.run_watch(still_slow, ticks=1)
        self.assertEqual(watcher_health(runtime)["consecutive_errors"], 2)   # the killed tick + this failure

    def test_health_cli_exit_codes(self):
        from reverie.runtime import main, heartbeat_path
        with patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(main(["--policy",str(self.path),"watcher-health"]),1)
            atomic_write(heartbeat_path(self.root/"state.json"), {"consecutive_errors":3,"last_ok_at":None})
            self.assertEqual(main(["--policy",str(self.path),"watcher-health"]),0)
            self.assertEqual(main(["--policy",str(self.path),"watcher-health","--healthy"]),1)
