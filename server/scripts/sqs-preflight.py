#!/usr/bin/env python3
"""Read-only verification of the delivery development SQS queue configuration."""
import json
import subprocess
import sys
from urllib.parse import urlsplit

REGION = 'ap-southeast-2'
ACCOUNT = '102364304362'
QUEUES = ('platform-events', 'outbox', 'notifications', 'dispatch', 'payments',
          'subscriptions', 'imports', 'maintenance')
PREFIX = 'delivery-dev-'


def check_pair(name, main, dlq):
    problems = []
    def expect(attrs, key, value, label):
        if attrs.get(key) != value:
            problems.append(f'{label}: {key} must be {value}')

    for attrs, label in ((main, 'work queue'), (dlq, 'dead-letter queue')):
        if attrs.get('FifoQueue', 'false') != 'false':
            problems.append(f'{label}: must be a Standard queue')
    expect(main, 'QueueArn', f'arn:aws:sqs:{REGION}:{ACCOUNT}:{name}', 'work queue')
    expect(dlq, 'QueueArn', f'arn:aws:sqs:{REGION}:{ACCOUNT}:{name}-dlq', 'dead-letter queue')
    for attrs, label in ((main, 'work queue'), (dlq, 'dead-letter queue')):
        expect(attrs, 'SqsManagedSseEnabled', 'true', label)
    for key, value in (('VisibilityTimeout', '120'), ('ReceiveMessageWaitTimeSeconds', '20'),
                       ('MessageRetentionPeriod', '345600'), ('DelaySeconds', '0')):
        expect(main, key, value, 'work queue')
    expect(dlq, 'MessageRetentionPeriod', '1209600', 'dead-letter queue')
    try:
        policy = json.loads(main.get('RedrivePolicy', '{}'))
        if not isinstance(policy, dict) or policy.get('deadLetterTargetArn') != dlq.get('QueueArn') or str(policy.get('maxReceiveCount')) != '5':
            problems.append('work queue: redrive must target its paired dead-letter queue after five receives')
    except (ValueError, TypeError):
        problems.append('work queue: invalid redrive policy')
    try:
        policy = json.loads(dlq.get('RedriveAllowPolicy', '{}'))
        if not isinstance(policy, dict) or policy.get('redrivePermission') != 'byQueue' or policy.get('sourceQueueArns') != [main.get('QueueArn')]:
            problems.append('dead-letter queue: redrive allow policy must permit only its paired work queue')
    except (ValueError, TypeError):
        problems.append('dead-letter queue: invalid redrive allow policy')
    return problems


def aws(*args):
    result = subprocess.run(['aws', '--profile', 'default', '--region', REGION, '--output', 'json', *args],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('AWS request failed; check the default profile and SQS read permissions')
    return json.loads(result.stdout or '{}')


def main():
    if aws('sts', 'get-caller-identity').get('Account') != ACCOUNT:
        raise RuntimeError('The default AWS profile is not signed into the expected account')
    urls = aws('sqs', 'list-queues', '--queue-name-prefix', PREFIX).get('QueueUrls', [])
    by_name = {urlsplit(url).path.rsplit('/', 1)[-1]: url for url in urls}
    issues = []
    for suffix in QUEUES:
        name = PREFIX + suffix
        missing = [item for item in (name, name + '-dlq') if item not in by_name]
        if missing:
            issues.extend(f'{item}: missing' for item in missing)
            continue
        attrs = []
        for item in (name, name + '-dlq'):
            result = aws('sqs', 'get-queue-attributes', '--queue-url', by_name[item],
                         '--attribute-names', 'All')
            attrs.append(result.get('Attributes', {}))
        issues.extend(f'{name}: {problem}' for problem in check_pair(name, *attrs))
    if issues:
        print('\n'.join(issues))
        return 1
    print('All eight SQS work queues and their dead-letter queues match the planned settings.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
