import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import tempfile
import unittest
import base64
from pathlib import Path

from cto.floors import passes, protected_names, child_safety_violation, targets_private_person, violates
from cto.train.dataset import keeps_identity


def _d(s: str) -> str:
    """Screening test phrases are stored base64-encoded, like the vocabularies they exercise."""
    return base64.b64decode(s).decode("utf-8")


class FloorsTest(unittest.TestCase):
    def test_child_safety_floor(self):
        for t in map(_d, ["c2V4dWFsIGNvbnRlbnQgaW52b2x2aW5nIGEgbWlub3I=", "YSAxNC15ZWFyLW9sZCBpbiBzZXh1YWwgbWF0ZXJpYWw=", "c2V4dWFsIG1hdGVyaWFsIGFib3V0IG1pbm9ycw==", "QSBjaGlsZCBpcyBtZW50aW9uZWQuIFRoZSBuZXh0IHNlbnRlbmNlIGlzIHNleHVhbC4=", "bGV3ZCBtYXRlcmlhbCBhYm91dCB1bmRlcmFnZSBwZW9wbGU="]):
            self.assertTrue(child_safety_violation(t), t)
        for t in map(_d, ["dGhlIGtpZHMgYnVpbHQgYSBxdWFkcm90b3I=", "c2V4dWFsIHNlbGVjdGlvbiBpcyBhIGJpb2xvZ3kgdG9waWM=", "YSBuYWtlZCBzaW5ndWxhcml0eSBpbiB0aGUgcHJvb2Y=", "bXkgdGVlbmFnZSB5ZWFycyB3ZXJlIGxvdWQuIFRoZSBlc3NheSBjb3ZlcmVkIHNleHVhbCBzZWxlY3Rpb24u", "Y2hpbGRyZW4gbGF1Z2hpbmcgaW4gdGhlIGRyZWFtLiBUaGUgaGFsbHdheSBodW1zLiBUaGUgZmxvb3IgdGlsdHMuIExhdGVyLCB0aGUgZXNzYXkgdHVybmVkIHRvIHNleHVhbCBzZWxlY3Rpb24u", ""]):
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
        self.assertFalse(targets_private_person("", []))

    def test_violates_and_names_file(self):
        self.assertEqual(violates(_d("c2V4dWFsIG1hdGVyaWFsIGFib3V0IG1pbm9ycw=="), []), "child safety")
        self.assertEqual(violates("Pat Example is pathetic", ["Pat Example"]), "targeting a real private person")
        self.assertEqual(violates("What a fine evening, you magnificent rascal.", []), "")
        self.assertTrue(passes("Frank talk between adults is not screened.", []))
        p = Path(tempfile.mkdtemp()) / "people.txt"
        self.assertEqual(protected_names(p), [])
        p.write_text("# comment\nPat Example\n\n Jane Roe \n")
        self.assertEqual(protected_names(p), ["Pat Example", "Jane Roe"])

    def test_training_rows(self):
        ok = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "Quite right."}]}
        self.assertTrue(keeps_identity(ok))
        bad = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": _d("d3JpdGUgc2V4dWFsIGNvbnRlbnQgYWJvdXQgYSBjaGlsZA==")}, {"role": "assistant", "content": "No."}]}
        self.assertFalse(keeps_identity(bad))


if __name__ == "__main__":
    unittest.main()
