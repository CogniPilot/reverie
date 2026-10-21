import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import tempfile
import unittest
from pathlib import Path

from cto.floors import passes, protected_names, child_safety_violation, targets_private_person, violates
from cto.train.dataset import keeps_identity
from tests.helpers import safety_floor_terms, synthetic_safety_lexicon


class FloorsTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(synthetic_safety_lexicon())

    def test_child_safety_violation(self):
        age_term, explicit_term = safety_floor_terms()
        for t in [f"{age_term} {explicit_term}", f"A {age_term} reference and {explicit_term} term.",
                  f"{explicit_term} then {age_term}.", f"{age_term} first. Then {explicit_term}.",
                  f"{explicit_term} first. Then {age_term}."]:
            self.assertTrue(child_safety_violation(t), t)
        for t in [f"The {age_term} built a quadrotor", f"{explicit_term} is a vocabulary entry",
                  f"A {explicit_term} singularity in the proof", f"Earlier years were busy. Now {explicit_term} is a term.",
                  f"The {age_term} explores. The hallway hums. Later the {explicit_term} term appears.", ""]:
            self.assertFalse(child_safety_violation(t), t)

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
        age_term, explicit_term = safety_floor_terms()
        self.assertEqual(violates(f"{explicit_term} with {age_term}", []), "child safety")
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
        age_term, explicit_term = safety_floor_terms()
        bad = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": f"Describe {explicit_term} {age_term}"}, {"role": "assistant", "content": "No."}]}
        self.assertFalse(keeps_identity(bad))


class PackagedLexiconTest(unittest.TestCase):
    def test_production_patterns_are_byte_identical_to_the_pre_packaging_version(self):
        import hashlib
        import re
        from cto import floors
        expected = {
            "minor": "f9d1ebc094544a7c6b9ce548963d102a7f464705506b9853ac4d952ecf4855c9",
            "explicit": "3dc375e3cecef2dc207a57b4d8c105057e3625ad47e201287efb59acc1282840",
            "abuse": "17bc40971d76efe811e5fbca0ae9a6975318e9383ff4079795ea744f6a883656",
        }
        for name, pattern in [("minor", floors._MINOR), ("explicit", floors._EXPLICIT), ("abuse", floors._ABUSE)]:
            self.assertEqual(hashlib.sha256(pattern.pattern.encode()).hexdigest(), expected[name])
            self.assertEqual(pattern.flags, re.compile("", re.I).flags)

    def test_corrupt_vocabulary_is_refused(self):
        import binascii
        from unittest.mock import patch
        from cto import floors
        with patch.dict(floors._LEXICON["patterns"], {"minor": "!"}):
            with self.assertRaises(binascii.Error):
                floors._lexicon("minor")


if __name__ == "__main__":
    unittest.main()
