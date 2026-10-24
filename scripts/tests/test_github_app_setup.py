import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configure_github_app import credential_bundle, secret_command, main


class GitHubAppSetupTests(unittest.TestCase):
    def test_check_deploys_matching_code_only_to_appcheck_before_setting_pair(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True
        with patch('sys.argv', ['configure_github_app.py', '--target', 'check']), \
             patch('sys.stdin', Terminal()), patch('sys.stderr', Terminal()), \
             patch('configure_github_app.wrangler_command', return_value=['wrangler']), \
             patch('configure_github_app.getpass.getpass', side_effect=['Ivfixtureclient', 'fixture-secret-only']), \
             patch('configure_github_app.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='')) as run, \
             redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 0)
        self.assertEqual(run.call_count, 2)
        first, second = run.call_args_list
        self.assertEqual(first.args[0][1:4], ['deploy', '--env', 'appcheck'])
        self.assertEqual(second.args[0][1:], ['secret', 'put', 'GITHUB_APP_CREDENTIALS', '--env', 'appcheck'])
        self.assertNotIn('input', first.kwargs)
        self.assertEqual(json.loads(second.kwargs['input'])['client_id'], 'Ivfixtureclient')

    def test_production_uploads_matching_code_then_one_pair_without_deploy_or_outputting_credentials(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True
        output = io.StringIO()
        with patch('sys.argv', ['configure_github_app.py', '--target', 'production', '--confirmed-real-app-test']), \
             patch('sys.stdin', Terminal()), patch('sys.stderr', Terminal()), \
             patch('configure_github_app.wrangler_command', return_value=['wrangler']), \
             patch('configure_github_app.getpass.getpass', side_effect=['Ivfixtureclient', 'fixture-secret-only']), \
             patch('configure_github_app.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='version 11111111-1111-1111-1111-111111111111')) as run, \
             redirect_stdout(output):
            self.assertEqual(main(), 0)
        self.assertEqual(run.call_count, 2)
        first, second = run.call_args_list
        self.assertEqual(first.args[0][1:3], ['versions', 'upload'])
        self.assertNotIn('input', first.kwargs)
        self.assertEqual(second.args[0][1:4], ['versions', 'secret', 'put'])
        self.assertEqual(json.loads(second.kwargs['input']), {'client_id':'Ivfixtureclient', 'client_secret':'fixture-secret-only'})
        self.assertNotIn('fixture-secret-only', output.getvalue())
        self.assertNotIn('Ivfixtureclient', output.getvalue())
        for call in run.call_args_list:
            self.assertNotIn('deploy', call.args[0])

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
