import importlib.util
import json
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / 'scripts' / 'sqs-preflight.py'
SPEC = importlib.util.spec_from_file_location('sqs_preflight', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class QueueConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.name = 'delivery-dev-payments'
        main_arn = f'arn:aws:sqs:ap-southeast-2:102364304362:{self.name}'
        dlq_arn = main_arn + '-dlq'
        self.main = {'QueueArn': main_arn, 'SqsManagedSseEnabled': 'true',
                     'VisibilityTimeout': '120', 'ReceiveMessageWaitTimeSeconds': '20',
                     'MessageRetentionPeriod': '345600', 'DelaySeconds': '0',
                     'RedrivePolicy': json.dumps({'deadLetterTargetArn': dlq_arn, 'maxReceiveCount': 5})}
        self.dlq = {'QueueArn': dlq_arn, 'SqsManagedSseEnabled': 'true',
                    'MessageRetentionPeriod': '1209600',
                    'RedriveAllowPolicy': json.dumps({'redrivePermission': 'byQueue', 'sourceQueueArns': [main_arn]})}

    def test_accepts_expected_standard_queues(self):
        self.assertEqual(MODULE.check_pair(self.name, self.main, self.dlq), [])

    def test_rejects_unrelated_dead_letter_queue_and_fifo(self):
        self.main['FifoQueue'] = 'true'
        self.dlq['RedriveAllowPolicy'] = json.dumps({'redrivePermission': 'allowAll'})
        self.assertEqual(len(MODULE.check_pair(self.name, self.main, self.dlq)), 2)

    def test_rejects_wrong_account_and_missing_encryption(self):
        self.main['QueueArn'] = self.main['QueueArn'].replace('102364304362', '123456789012')
        self.main.pop('SqsManagedSseEnabled')
        self.assertGreaterEqual(len(MODULE.check_pair(self.name, self.main, self.dlq)), 2)

    def test_rejects_malformed_policy_shapes_without_crashing(self):
        self.main['RedrivePolicy'] = '[]'
        self.dlq['RedriveAllowPolicy'] = 'null'
        self.assertEqual(len(MODULE.check_pair(self.name, self.main, self.dlq)), 2)


if __name__ == '__main__':
    unittest.main()
