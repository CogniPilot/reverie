import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import tempfile
import unittest
from pathlib import Path

from reverie.floors import passes, protected_names, output_policy_violation, targets_private_person, violates
from reverie.train.dataset import keeps_identity
from tests.helpers import output_policy_terms, synthetic_output_policy


class FloorsTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(synthetic_output_policy())

    def test_configured_output_policy(self):
        first, second = output_policy_terms()
        self.assertTrue(output_policy_violation(first + " " + second))
        self.assertFalse(output_policy_violation(first))
        self.assertFalse(output_policy_violation("Ordinary technical text."))

    def test_private_person(self):
        names = ["Pat Example"]
        self.assertTrue(targets_private_person("Pat Example abuse_marker", names))
        self.assertTrue(targets_private_person("let's find out where Pat Example lives at night", names))
        self.assertFalse(targets_private_person("Pat Example sent a nice note", names))
        self.assertFalse(targets_private_person("abuse_marker User", names))          # not on the list
        self.assertTrue(targets_private_person("Call Jane Roe at 555-123-4567 and tell her", []))
        self.assertTrue(targets_private_person("Jane Roe, 12 Elm Street, knows", []))
        self.assertTrue(targets_private_person("mail Jane Roe at jane@example.com", []))
        self.assertFalse(targets_private_person("the build took 555 seconds and 12345678901 cycles", []))
        # Addresses, versions and dates are not contact details, even beside a capitalised name.
        for benign in ("The Model Router listens on 192.0.2.10 now", "Home Server is 10.20.30.12 on the LAN",
                       "Build Tools moved to 1.19.1 and 10.2.3.4", "Release Notes for 2026-10-16 are out",
                       "Home Lab hosts sit on 10.20.30.x behind the router", "Private Range 10.0.0.0/8 is local",
                       "Model Router at 192.0.2.10:8080 answered", "Build Tools v1.19.10 shipped",
                       "Home Server (10.20.30.12), on the LAN", "Model Router on `192.0.2.10` and **127.0.0.1**"):
            self.assertFalse(targets_private_person(benign, []), benign)
        # Real contact details still trip: US, continental and short dotted shapes, any group above 255, and a
        # phone beside an IP.
        for contact in ("Call Jane Roe at 555.123.4567 tonight", "Jane Roe: +1 (555) 123-4567",
                        "Jane Roe is on 10.20.30.12 and 555-123-4567", "Text Jane Roe at 5551234567",
                        "Appelez Jean Dupont au 06.12.34.56.78", "Jean Dupont, bureau 01.42.68.53.00",
                        "Jane Roe at 123.456.789", "Jean Dupont: +33 6 12 34 56 78", "Jean Dupont au 06 12 34 56 78",
                        "Jane Roe 999.168.1.10", "Jane Roe 10.20.30.12.5", "Jane Roe (06.12.34.56.78)", "Jane Roe `06.12.34.56.78`"):
            self.assertTrue(targets_private_person(contact, []), contact)
        self.assertFalse(targets_private_person("", []))

    def test_violates_and_names_file(self):
        first_marker, second_marker = output_policy_terms()
        self.assertEqual(violates(f"{second_marker} with {first_marker}", []), "configured output policy")
        self.assertEqual(violates("Pat Example abuse_marker", ["Pat Example"]), "targeting a real private person")
        self.assertEqual(violates("An ordinary evening outside either detector category.", []), "")
        self.assertTrue(passes("Ordinary technical topics outside these categories pass.", []))
        p = Path(tempfile.mkdtemp()) / "people.txt"
        self.assertEqual(protected_names(p), [])
        p.write_text("# comment\nPat Example\n\n Jane Roe \n")
        self.assertEqual(protected_names(p), ["Pat Example", "Jane Roe"])

    def test_training_rows(self):
        ok = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "Certainly."}]}
        self.assertTrue(keeps_identity(ok))
        first_marker, second_marker = output_policy_terms()
        bad = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": f"Describe {second_marker} {first_marker}"}, {"role": "assistant", "content": "No."}]}
        self.assertFalse(keeps_identity(bad))


class OutputPolicyValidationTest(unittest.TestCase):
    def test_invalid_rules_are_refused_and_no_policy_is_topic_neutral(self):
        import re
        from unittest.mock import patch
        from reverie.floors import output_policy_violation
        for raw in ('{"denied_patterns": [1]}', '{"unknown": []}', '{"denied_patterns": ["["]}'):
            with self.subTest(raw=raw), patch.dict("os.environ", {"REVERIE_OUTPUT_POLICY": raw}):
                with self.assertRaises((ValueError, re.error)):
                    output_policy_violation("anything")
        with patch.dict("os.environ", {"REVERIE_OUTPUT_POLICY": "{}"}):
            self.assertFalse(output_policy_violation("No topics are configured."))
