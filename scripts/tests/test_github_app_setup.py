import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configure_github_app import credential_bundle, secret_command


class GitHubAppSetupTests(unittest.TestCase):
    def test_pair_is_one_payload_not_command_arguments(self):
        payload = credential_bundle("Ivtestclient", "test-secret-not-real")
        self.assertEqual(json.loads(payload), {"client_id": "Ivtestclient", "client_secret": "test-secret-not-real"})
        check = secret_command("check", ["wrangler"])
        production = secret_command("production", ["wrangler"])
        self.assertEqual(check, ["wrangler", "secret", "put", "GITHUB_APP_CREDENTIALS", "--env", "appcheck"])
        self.assertEqual(production[1:4], ["versions", "secret", "put"])
        self.assertNotIn("test-secret-not-real", production)
        self.assertNotIn("Ivtestclient", production)

    def test_wrong_app_type_partial_or_whitespace_is_rejected_without_value_in_error(self):
        for client, secret in [("Ovwrongtype", "fixture"), (" Ivtest", "fixture"), ("Ivtest", ""), ("Ivtest", "bad secret")]:
            with self.assertRaises(ValueError) as caught:
                credential_bundle(client, secret)
            self.assertNotIn(client, str(caught.exception))
            if secret:
                self.assertNotIn(secret, str(caught.exception))
