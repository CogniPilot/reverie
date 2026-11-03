#!/usr/bin/env python3
"""Closed adapter: reverie-prune run summaries and A1 exception reports -> receipt-shaped records (RECEIPTS lane).

It binds existing producer output to the accepted ops semantics (efficiency-ops-interface-r4: resource
ADMISSION/TERMINAL and EVIDENCE) without inventing an authority store:
  - a dry run, or any run without operator-supplied admission context, is an OBSERVATION (codes WOULD_* / REPORTED_*);
  - a TERMINAL record is emitted only when the trusted context binds that run_id to an existing admission
    (idempotency_key and lease_id as actually supplied); otherwise effect fields are "UNAVAILABLE", never zero/empty;
  - actor, producer and host references come only from the operator's context file, never from log payloads;
  - every record states evidence_level "PRODUCER_OUTPUT_UNAUTHENTICATED": the prune's files are not tamper-proof.
Records are a fixed schema with fixed codes, bounded integers and validated short identifiers: no paths, argv,
stderr, prompts or free text. receipt_id is the sha256 of the record's canonical identity; an identical record is a
counted duplicate, the same receipt_id with different bytes is refused (CONFLICT) and never written. New records are
written and fsynced to a staging file before they are appended (and fsynced) to the output; any failure leaves the
run's status UNKNOWN (exit 3). Retention (entries, bytes, age) drops whole oldest records and appends a
RETENTION_DROP record with the count. Exit 0 ok, 1 refusals/conflicts (others still written), 2 usage, 3 output UNKNOWN.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_INT = (1 << 53) - 1
DECISIONS = ("WOULD_DELETE", "DELETED", "SKIP", "PARTIAL", "REPORT", "NOT_REGISTERED", "WIDEN_REFUSED",
             "STOPPED_CEILING", "LEASE_LONG_HELD")
A1_COUNTS = ("runs", "runs_with_problems", "partial_rows", "unknown_rows", "safety_refused_rows", "deleted_rows",
             "ceiling_hit_runs", "in_use_after_would_delete_paths", "undated_logs_outside_window")
A1_LISTS = ("leases_held", "leases_long_held", "not_registered", "retired_by_size", "partial", "widen_refused",
            "refused_for_safety")
# reverie-prune exits: 0 ok, 2 precondition/config refused, 3 live not enabled, 4 partial, 5 another run busy. It writes a
# summary only for 0 and 4; the others are mapped too so a summary written by a later revision is never misclassified.
EXIT_CODES = {0: ("OK", "RUN_OK"), 2: ("REFUSED", "RUN_PRECONDITION_REFUSED"), 3: ("REFUSED", "RUN_LIVE_NOT_ENABLED"),
              4: ("PARTIAL", "RUN_PARTIAL"), 5: ("REFUSED", "RUN_BUSY")}
UNAVAILABLE = "UNAVAILABLE"
LEVEL = "PRODUCER_OUTPUT_UNAUTHENTICATED"


class Refused(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


def bounded_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_INT:
        raise Refused("FIELD_OUT_OF_BOUNDS", name)
    return value


def ident(value):
    """A short opaque identifier, or UNAVAILABLE. Anything that could carry a path, address or free text is refused."""
    if value is None:
        return UNAVAILABLE
    if not isinstance(value, str) or not ID_RE.match(value):
        raise Refused("PRIVATE_OR_INVALID_STRING", "identifier")
    return value


def file_ref(path, max_bytes):
    size = os.lstat(path).st_size
    if size > max_bytes:
        raise Refused("INPUT_OVERSIZE", os.path.basename(path))
    with open(path, "rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise Refused("INPUT_OVERSIZE", os.path.basename(path))
    return data, {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def load_context(path):
    """The operator's trusted producer context. Only these keys are read; each is validated."""
    if not path:
        return {"producer_source_sha256": UNAVAILABLE, "config_sha256": UNAVAILABLE, "actor_ref": UNAVAILABLE,
                "host_key": UNAVAILABLE, "admissions": {}}, []
    with open(path) as handle:
        raw = json.load(handle)
    rejected = []
    out = {}
    for key in ("producer_source_sha256", "config_sha256"):
        value = raw.get(key)
        out[key] = value if isinstance(value, str) and SHA_RE.match(value) else UNAVAILABLE
        if value is not None and out[key] == UNAVAILABLE:
            rejected.append(key)
    for key in ("actor_ref", "host_key"):
        try:
            out[key] = ident(raw.get(key))
        except Refused:
            out[key] = UNAVAILABLE
            rejected.append(key)
    admissions = {}
    for run_id, binding in (raw.get("admissions") or {}).items():
        try:
            admissions[ident(run_id)] = {"idempotency_key": ident(binding.get("idempotency_key")),
                                         "lease_id": ident(binding.get("lease_id"))}
        except (Refused, AttributeError):
            rejected.append("admissions")
    out["admissions"] = admissions
    return out, rejected


def finish(record, keys=("event_kind", "run_id")):
    """A prune run's identity is (kind, run_id): the same run with different bytes is a CONFLICT. An A1 report's
    identity includes its own sha256 (each report is its own subject)."""
    identity = {k: record[k] for k in keys}
    record["receipt_id"] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return json.dumps(record, sort_keys=True, separators=(",", ":"))


def base(kind, run_id, ctx, ref, utc):
    return {"version": VERSION, "event_kind": kind, "run_id": run_id, "utc": utc, "evidence_level": LEVEL,
            "producer": {"source_sha256": ctx["producer_source_sha256"], "config_sha256": ctx["config_sha256"]},
            "actor_ref": ctx["actor_ref"], "host_key": ctx["host_key"], "subject_sha256": ref["sha256"],
            "evidence_ref": {"kind": kind.split("_")[0].lower(), "sha256": ref["sha256"], "bytes": ref["bytes"]}}


def run_time(run_id):
    """The run's own start time from reverie-prune's default run id (%Y%m%dT%H%M%SZ-...); not the file mtime."""
    m = re.match(r"^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z", run_id)
    return "%s-%s-%sT%s:%s:%sZ" % m.groups() if m else UNAVAILABLE


def from_summary(path, ctx, max_bytes):
    data, ref = file_ref(path, max_bytes)
    try:
        summary = json.loads(data)
    except ValueError:
        raise Refused("INPUT_UNREADABLE", os.path.basename(path))
    if not isinstance(summary, dict):
        raise Refused("INPUT_UNREADABLE", os.path.basename(path))
    run_id = summary.get("run_id")
    if run_id is None:
        raise Refused("MISSING_IDENTITY", "run_id")
    run_id = ident(run_id)
    if os.path.basename(path) != run_id + ".summary.json":
        raise Refused("IDENTITY_MISMATCH", "file name and run_id differ")
    mode = summary.get("mode")
    if mode not in ("dry", "live"):
        raise Refused("FIELD_OUT_OF_BOUNDS", "mode")
    exit_code = summary.get("exit")
    result_class, code = EXIT_CODES.get(exit_code, ("FAILED", "RUN_FAILED")) if isinstance(exit_code, int) \
        else ("UNKNOWN", "RUN_EXIT_UNKNOWN")
    counts = {}
    for decision, n in (summary.get("by_decision") or {}).items():
        if decision not in DECISIONS:
            raise Refused("FIELD_OUT_OF_BOUNDS", "by_decision")
        counts[decision] = bounded_int(n, "by_decision")
    total = bounded_int(summary.get("deleted_or_would_bytes", 0), "deleted_or_would_bytes")
    df = []
    for row in summary.get("df_before") or []:  # paths dropped: position only
        df.append({"total": bounded_int(row.get("total", 0), "df"), "free_before": bounded_int(row.get("free", 0), "df")})
    for i, row in enumerate(summary.get("df_after") or []):
        if i < len(df):
            df[i]["free_after"] = bounded_int(row.get("free", 0), "df")
    admission = ctx["admissions"].get(run_id)
    live_bound = mode == "live" and admission is not None
    kind = "PRUNE_TERMINAL" if live_bound else "PRUNE_OBSERVATION"
    record = base(kind, run_id, ctx, ref, run_time(run_id))
    record.update({
        "effect": admission if live_bound else {"idempotency_key": UNAVAILABLE, "lease_id": UNAVAILABLE},
        "result_class": result_class, "code": code,
        "source": {"mode": mode, "exit": exit_code if isinstance(exit_code, int) else UNAVAILABLE,
                   "passes": [p for p in (summary.get("passes") or []) if p in ("high-water", "checkouts", "retired", "leases")],
                   "by_decision": counts, "ceiling_hit": bool(summary.get("ceiling_hit")), "df": df},
        # A dry total is an estimate, never reclaimed bytes; a live total is the prune's own counter, not observed free space.
        "metrics": {"would_delete_bytes": total if mode == "dry" else 0,
                    "reported_deleted_bytes": total if mode == "live" else 0},
        "codes": ["WOULD_DELETE"] if mode == "dry" and counts.get("WOULD_DELETE") else
                 (["REPORTED_DELETED"] if mode == "live" and counts.get("DELETED") else []),
    })
    return finish(record)


def from_a1(path, ctx, max_bytes):
    data, ref = file_ref(path, max_bytes)
    try:
        report = json.loads(data)
    except ValueError:
        raise Refused("INPUT_UNREADABLE", os.path.basename(path))
    if not isinstance(report, dict) or report.get("tool") != "prune_exceptions":
        raise Refused("MISSING_IDENTITY", "not an A1 report")
    gate = report.get("gate") or {}
    window = report.get("window") or {}
    window_id = "a1-%s-%s" % (re.sub(r"[^0-9TZ]", "", str(window.get("since") or "start")),
                              re.sub(r"[^0-9TZ]", "", str(window.get("until") or report.get("generated_utc") or "now")))
    record = base("A1_EXCEPTIONS", ident(window_id[:64]), ctx, ref,
                  report.get("generated_utc") if isinstance(report.get("generated_utc"), str)
                  and re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", report["generated_utc"]) else UNAVAILABLE)
    counts = {name: bounded_int(gate.get(name, 0), name) for name in A1_COUNTS}
    counts.update({name + "_count": bounded_int(len(report.get(name) or []), name) for name in A1_LISTS})
    problem_runs = []
    for item in (report.get("run_problems") or [])[:20]:
        try:
            problem_runs.append(ident(item.get("run_id")))
        except (Refused, AttributeError):
            problem_runs.append(UNAVAILABLE)
    record.update({"effect": {"idempotency_key": UNAVAILABLE, "lease_id": UNAVAILABLE},
                   "result_class": "OBSERVATION",
                   "code": "EXCEPTIONS_PRESENT" if counts["runs_with_problems"] or any(
                       counts[n + "_count"] for n in A1_LISTS) else "NO_EXCEPTIONS",
                   "metrics": counts, "problem_run_ids": problem_runs, "codes": []})
    return finish(record, ("event_kind", "run_id", "subject_sha256"))


def existing(out_path):
    ids = {}
    if os.path.exists(out_path):
        with open(out_path) as handle:
            for line in handle:
                if line.strip():
                    ids[json.loads(line)["receipt_id"]] = line.rstrip("\n")
    return ids


def retain(out_path, max_entries, max_bytes, max_age_days, now):
    with open(out_path) as handle:
        lines = [l.rstrip("\n") for l in handle if l.strip()]
    keep = lines
    if max_age_days:
        cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - max_age_days * 86400))
        keep = [l for l in keep if json.loads(l).get("utc", UNAVAILABLE) == UNAVAILABLE or json.loads(l)["utc"] >= cutoff]
    if max_entries and len(keep) > max_entries:
        keep = keep[-max_entries:]
    while max_bytes and keep and sum(len(l) + 1 for l in keep) > max_bytes:
        keep = keep[1:]
    dropped = len(lines) - len(keep)
    if dropped:
        tmp = out_path + ".retain"
        with open(tmp, "x") as handle:
            for l in keep:
                handle.write(l + "\n")
            note = {"version": VERSION, "event_kind": "RETENTION_DROP",
                    "run_id": "retention-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now)), "subject_sha256":
                    hashlib.sha256(("\n".join(lines[:dropped])).encode()).hexdigest(),
                    "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "evidence_level": LEVEL,
                    "result_class": "OBSERVATION", "code": "RETENTION_DROPPED", "metrics": {"dropped": dropped}}
            handle.write(finish(note) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, out_path)
    return dropped


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--log-dir", help="reverie-prune log_dir (reads *.summary.json)")
    parser.add_argument("--a1", action="append", default=[], help="an A1 report JSON; repeatable")
    parser.add_argument("--context", help="operator's trusted producer context JSON")
    parser.add_argument("--out", required=True, help="append-only receipts JSONL")
    parser.add_argument("--max-input-bytes", type=int, default=1 << 20)
    parser.add_argument("--max-entries", type=int, default=100000)
    parser.add_argument("--max-bytes", type=int, default=64 << 20)
    parser.add_argument("--max-age-days", type=float, default=0)
    args = parser.parse_args(argv)
    ctx, rejected_context = load_context(args.context)
    inputs = []
    if args.log_dir:
        for name in sorted(os.listdir(args.log_dir)):
            path = os.path.join(args.log_dir, name)
            if name.endswith(".summary.json") and os.path.isfile(path) and not os.path.islink(path):
                inputs.append((from_summary, path))
    inputs += [(from_a1, p) for p in args.a1]
    have = existing(args.out)
    new, refusals, duplicates = [], [], 0
    for build, path in inputs:
        try:
            line = build(path, ctx, args.max_input_bytes)
        except Refused as refusal:
            refusals.append(refusal.code)
            continue
        rid = json.loads(line)["receipt_id"]
        if rid in have or rid in {json.loads(n)["receipt_id"] for n in new}:
            prior = have.get(rid) or next(n for n in new if json.loads(n)["receipt_id"] == rid)
            if prior == line:
                duplicates += 1
            else:
                refusals.append("CONFLICT")
            continue
        new.append(line)
    status = "COMMITTED"
    try:
        if new:
            stage = args.out + ".stage"
            with open(stage, "x") as handle:
                handle.write("".join(l + "\n" for l in new))
                handle.flush()
                os.fsync(handle.fileno())
            with open(args.out, "a") as handle:
                handle.write("".join(l + "\n" for l in new))
                handle.flush()
                os.fsync(handle.fileno())
            os.remove(stage)
        dropped = retain(args.out, args.max_entries, args.max_bytes, args.max_age_days, time.time()) \
            if os.path.exists(args.out) else 0
    except OSError:
        status, dropped = "UNKNOWN", 0
    counts = {}
    for code in refusals:
        counts[code] = counts.get(code, 0) + 1
    print(json.dumps({"status": status, "written": len(new) if status == "COMMITTED" else 0, "duplicates": duplicates,
                      "refused": counts, "context_fields_rejected": sorted(set(rejected_context)),
                      "retention_dropped": dropped}, sort_keys=True))
    if status != "COMMITTED":
        return 3
    return 1 if refusals else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
