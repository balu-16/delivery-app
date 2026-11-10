#!/usr/bin/env python3
"""AWS credential_process: use a scoped, short-lived session, never write credentials to disk."""
import json
import os
import re
import subprocess
import sys

def main():
    region = os.environ['AWS_REGION']
    account = os.environ['AWS_ACCOUNT_ID']
    cluster = os.environ['RDS_CLUSTER_RESOURCE_ID']
    instance = os.environ['RDS_INSTANCE_RESOURCE_ID']
    database_user = os.environ['RDS_RUNTIME_USER']
    cache = os.environ['CACHE_IAM_NAME']
    cache_user = os.environ['CACHE_IAM_USER']
    pool = os.environ['COGNITO_WORKFORCE_POOL_ID']
    prefix = f'arn:aws:'
    queue_lanes = ('platform-events', 'outbox', 'notifications', 'dispatch',
                   'payments', 'subscriptions', 'imports', 'maintenance')
    queue_prefix = os.environ.get('SQS_QUEUE_PREFIX') or 'delivery-dev'
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', queue_prefix):
        raise ValueError('Invalid queue prefix')
    policy = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': 'rds-db:connect', 'Resource': [f'{prefix}rds-db:{region}:{account}:dbuser:{cluster}/{database_user}', f'{prefix}rds-db:{region}:{account}:dbuser:{instance}/{database_user}']},
        {'Effect': 'Allow', 'Action': 'elasticache:Connect', 'Resource': [f'{prefix}elasticache:{region}:{account}:serverlesscache:{cache}', f'{prefix}elasticache:{region}:{account}:user:{cache_user}']},
        {'Effect': 'Allow', 'Action': ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminResetUserPassword'], 'Resource': f'{prefix}cognito-idp:{region}:{account}:userpool/{pool}'},
        {'Effect': 'Allow', 'Action': ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'], 'Resource': [f'{prefix}sqs:{region}:{account}:{queue_prefix}-{lane}' for lane in queue_lanes]},
    ]}
    source_env = dict(os.environ)
    for key in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        source_env.pop(key, None)
    result = subprocess.run(['aws', 'sts', 'get-federation-token', '--profile', 'default', '--region', region, '--name', 'delivery-runtime', '--duration-seconds', '3600', '--policy', json.dumps(policy, separators=(',', ':')), '--output', 'json'], env=source_env, capture_output=True, check=True, text=True, timeout=30)
    creds = json.loads(result.stdout)['Credentials']
    print(json.dumps({'Version': 1, 'AccessKeyId': creds['AccessKeyId'], 'SecretAccessKey': creds['SecretAccessKey'], 'SessionToken': creds['SessionToken'], 'Expiration': creds['Expiration']}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Unable to obtain the restricted delivery AWS session', file=sys.stderr)
        sys.exit(1)
