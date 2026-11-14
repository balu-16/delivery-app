import contextlib
import importlib.util
import io
import json
import os
import pathlib
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / 'scripts' / 'aws-restricted-session.py'
SPEC = importlib.util.spec_from_file_location('aws_restricted_session', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RestrictedSessionPolicyTest(unittest.TestCase):
    def setUp(self):
        self.env = {
            'AWS_REGION': 'ap-southeast-2',
            'AWS_ACCOUNT_ID': '123456789012',
            'RDS_CLUSTER_RESOURCE_ID': 'cluster-test',
            'RDS_INSTANCE_RESOURCE_ID': 'instance-test',
            'RDS_RUNTIME_USER': 'runtime',
            'CACHE_IAM_NAME': 'delivery-app',
            'CACHE_IAM_USER': 'default.iam-user',
            'COGNITO_WORKFORCE_POOL_ID': 'ap-southeast-2_example',
        }
        self.queue_url = 'https://sqs.ap-southeast-2.amazonaws.com/123456789012/customer-group'

    def policy(self, env):
        class Response:
            stdout = json.dumps({'Credentials': {'AccessKeyId': 'test', 'SecretAccessKey': 'test',
                                'SessionToken': 'test', 'Expiration': 'test'}})

        with patch.dict(os.environ, env, clear=True), patch.object(MODULE.subprocess, 'run', return_value=Response()) as run, contextlib.redirect_stdout(io.StringIO()):
            MODULE.main()
        command = run.call_args.args[0]
        return json.loads(command[command.index('--policy') + 1])

    def test_group_queue_only_receives_send_permission(self):
        policy = self.policy({**self.env, 'CUSTOMER_GROUP_SYNC_QUEUE_URL': self.queue_url})
        expected = 'arn:aws:sqs:ap-southeast-2:123456789012:customer-group'
        grants = [entry for entry in policy['Statement'] if expected in ([entry['Resource']] if isinstance(entry['Resource'], str) else entry['Resource'])]
        self.assertEqual(grants, [{'Effect': 'Allow', 'Action': 'sqs:SendMessage', 'Resource': expected}])
        self.assertLessEqual(len(json.dumps(policy, separators=(',', ':'))), 2048)

    def test_optional_queue_preserves_existing_queue_permissions(self):
        policy = self.policy(self.env)
        sqs = [entry for entry in policy['Statement'] if isinstance(entry['Action'], list) and 'sqs:ReceiveMessage' in entry['Action']]
        self.assertEqual(len(sqs), 1)
        self.assertEqual(len(sqs[0]['Resource']), 8)

    def test_rejects_urls_outside_the_configured_account_or_region(self):
        for url in (
            'https://sqs.ap-southeast-2.amazonaws.com/999999999999/customer-group',
            'https://sqs.us-east-1.amazonaws.com/123456789012/customer-group',
            'https://sqs.ap-southeast-2.amazonaws.com.evil.test/123456789012/customer-group',
            'http://sqs.ap-southeast-2.amazonaws.com/123456789012/customer-group',
            self.queue_url + '?x=1',
            self.queue_url + '/extra',
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.policy({**self.env, 'CUSTOMER_GROUP_SYNC_QUEUE_URL': url})


if __name__ == '__main__':
    unittest.main()
