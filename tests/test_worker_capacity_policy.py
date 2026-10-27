"""Exact policy boundaries and compatibility; no native observation or effects."""
import unittest
from reverie import worker_capacity_policy as P


class CapacityPolicy(unittest.TestCase):
    def test_legacy_conservative_boundary_retained(self):
        self.assertTrue(P.legacy_headroom_fits(82 * P.GIB, 100 * P.GIB))
        self.assertFalse(P.legacy_headroom_fits(82 * P.GIB + 1, 100 * P.GIB))
        self.assertFalse(P.legacy_headroom_fits(26 * P.GIB, 32 * P.GIB))
        for total in (None, False, 0, -1, 'unknown'):
            self.assertFalse(P.legacy_headroom_fits(P.GIB, total))

    def test_explicit_policy_uses_selected_site_and_reserve_at_exact_byte_boundary(self):
        for pool, site, reserve in ((48, 8, 8), (96, 16, 16), (20, 4, 8)):
            values=dict(pool_bytes=pool*P.GIB, site_bytes=site*P.GIB,
                        reserve_bytes=reserve*P.GIB, total_bytes=(pool+site+reserve)*P.GIB,
                        available_bytes=reserve*P.GIB)
            with self.subTest(pool=pool):
                self.assertTrue(P.explicit_host_headroom_fits(**values))
                self.assertFalse(P.explicit_host_headroom_fits(**dict(values,total_bytes=values['total_bytes']-1)))
                self.assertFalse(P.explicit_host_headroom_fits(**dict(values,available_bytes=values['available_bytes']-1)))
        # An explicit complete owner policy can differ from the legacy margin.
        self.assertTrue(P.explicit_host_headroom_fits(pool_bytes=26*P.GIB,site_bytes=3*P.GIB,
                        reserve_bytes=2*P.GIB,total_bytes=32*P.GIB,available_bytes=4*P.GIB))

    def test_required_explicit_facts_are_not_default_zero_or_legacy_fallback(self):
        values=dict(pool_bytes=20*P.GIB,site_bytes=4*P.GIB,reserve_bytes=4*P.GIB,
                    total_bytes=32*P.GIB,available_bytes=8*P.GIB)
        for key in values:
            for bad in (None,False,'unknown',-1,1.0,P.MAX_COUNTER+1):
                with self.subTest(key=key,kind=type(bad).__name__),self.assertRaises(P.CapacityFactsUnknown):
                    P.explicit_host_headroom_fits(**dict(values,**{key:bad}))
            missing=dict(values);del missing[key]
            with self.assertRaises(TypeError):P.explicit_host_headroom_fits(**missing)
        with self.assertRaises(P.CapacityFactsUnknown):
            P.explicit_host_headroom_fits(**dict(values,available_bytes=values['total_bytes']+1))

    def test_retained_and_new_charges_never_receive_automatic_credit(self):
        self.assertTrue(P.pool_headroom_fits(budget_bytes=100,committed_bytes=60,retained_bytes=20,candidate_bytes=20))
        self.assertFalse(P.pool_headroom_fits(budget_bytes=100,committed_bytes=60,retained_bytes=20,candidate_bytes=21))
        self.assertFalse(P.pool_headroom_fits(budget_bytes=100,committed_bytes=80,retained_bytes=21,candidate_bytes=0))
        for key in ('committed_bytes','retained_bytes','candidate_bytes'):
            values=dict(budget_bytes=100,committed_bytes=60,retained_bytes=20,candidate_bytes=20)
            values[key]=-1
            with self.assertRaises(P.CapacityFactsUnknown):P.pool_headroom_fits(**values)
        with self.assertRaises(TypeError):P.pool_headroom_fits(budget_bytes=100,committed_bytes=60,candidate_bytes=20)
