"""Pure memory-capacity policy; never observation, approval or launch authority.

The optional explicit policy consumes facts from the fixed native observer.
Its callers must qualify host/cgroup/website identity and retained claims in
that operation's context. No missing value implies zero and no failed explicit
policy falls back to legacy. Installation acceptance is not actor readiness.
"""
VERSION = 'explicit-owner-reserve-v1'
GIB = 1 << 30
MAX_COUNTER = (1 << 63) - 1


class CapacityFactsUnknown(ValueError):
    pass


def _counter(value, *, positive=False):
    if type(value) is not int or not (1 if positive else 0) <= value <= MAX_COUNTER:
        raise CapacityFactsUnknown('CAPACITY_INTEGER_FACT_REQUIRED')
    return value


def legacy_headroom_fits(worker_bytes, total_bytes):
    """Keep the pre-existing absent-option 90% plus 8 GiB predicate exactly."""
    return (type(worker_bytes) is int and worker_bytes >= 0 and
            type(total_bytes) is int and total_bytes > 0 and
            worker_bytes + 8 * GIB <= total_bytes * .9)


def explicit_host_headroom_fits(*, pool_bytes, site_bytes, reserve_bytes,
                                total_bytes, available_bytes):
    """Reserve the whole configured worker pool, actual site cap and host reserve.

    Effective native ancestor bounds and complete current commitments remain
    required observer facts, not guessed inputs supplied by a browser/request.
    All arithmetic is exact bytes. This does not subtract current usage again.
    """
    for value in (pool_bytes, site_bytes, reserve_bytes, total_bytes):
        _counter(value, positive=True)
    _counter(available_bytes)
    if available_bytes > total_bytes:
        raise CapacityFactsUnknown('CAPACITY_HOST_FACTS_INCONSISTENT')
    return (pool_bytes + site_bytes + reserve_bytes <= total_bytes and
            available_bytes >= reserve_bytes)


def pool_headroom_fits(*, budget_bytes, committed_bytes, retained_bytes, candidate_bytes):
    """Charge native commitments, qualified held deltas and a candidate once.

    Callers explicitly provide zero only where that context has no such charge.
    A cold unavailable source retains its fence and grants no effect permission;
    this arithmetic does not qualify its binding or release a retained claim.
    """
    _counter(budget_bytes, positive=True)
    for value in (committed_bytes, retained_bytes, candidate_bytes):
        _counter(value)
    return committed_bytes + retained_bytes + candidate_bytes <= budget_bytes
