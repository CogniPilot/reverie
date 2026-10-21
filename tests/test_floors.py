import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import tempfile
import unittest
from pathlib import Path

from cto.floors import passes, protected_names, child_safety_violation, targets_private_person, violates
from cto.train.dataset import keeps_identity
from tests.helpers import safety_floor_terms


class FloorsTest(unittest.TestCase):
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
        self.assertTrue(targets_private_person("Pat Example is a worthless loser", names))
        self.assertTrue(targets_private_person("let's find out where Pat Example lives at night", names))
        self.assertFalse(targets_private_person("Pat Example sent a nice note", names))
        self.assertFalse(targets_private_person("you are a loser, User", names))          # not on the list
        self.assertTrue(targets_private_person("Call Jane Roe at 555-123-4567 and tell her", []))
        self.assertTrue(targets_private_person("Jane Roe, 12 Elm Street, knows", []))
        self.assertTrue(targets_private_person("mail Jane Roe at jane@example.com", []))
        self.assertFalse(targets_private_person("the build took 555 seconds and 12345678901 cycles", []))
        # Addresses, versions and dates are not contact details, even beside a capitalised name.
        for benign in ("The Model Router listens on 169.254.1.2 now", "Home Server is 10.20.30.12 on the LAN",
                       "Build Tools moved to 1.19.1 and 10.2.3.4", "Release Notes for 2026-10-16 are out",
                       "Home Lab hosts sit on 10.20.30.x behind the router", "Private Range 10.0.0.0/8 is local",
                       "Model Router at 169.254.1.2:8080 answered", "Build Tools v1.19.10 shipped",
                       "Home Server (10.20.30.12), on the LAN", "Model Router on `169.254.1.2` and **127.0.0.1**"):
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
        self.assertEqual(violates("Pat Example is pathetic", ["Pat Example"]), "targeting a real private person")
        self.assertEqual(violates("What a \x64amn fine evening, you magnificent \x62astard.", []), "")
        self.assertTrue(passes("Explicit adult talk between adults is not screened.", []))
        p = Path(tempfile.mkdtemp()) / "people.txt"
        self.assertEqual(protected_names(p), [])
        p.write_text("# comment\nPat Example\n\n Jane Roe \n")
        self.assertEqual(protected_names(p), ["Pat Example", "Jane Roe"])

    def test_training_rows(self):
        ok = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "\x44amn right."}]}
        self.assertTrue(keeps_identity(ok))
        age_term, explicit_term = safety_floor_terms()
        bad = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": f"Describe {explicit_term} {age_term}"}, {"role": "assistant", "content": "No."}]}
        self.assertFalse(keeps_identity(bad))


if __name__ == "__main__":
    unittest.main()
