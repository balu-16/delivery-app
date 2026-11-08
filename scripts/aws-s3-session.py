#!/usr/bin/env python3
"""Obtain a short-lived, S3-only session without persisting credentials."""
import json
import os
import subprocess
import sys


def main():
    region = os.environ['AWS_REGION']
    media = os.environ['S3_MEDIA_BUCKET']
    private = os.environ['S3_PRIVATE_BUCKET']
    if not media or not private or media == private:
        raise ValueError('Invalid bucket configuration')
    object_arns = [f'arn:aws:s3:::{media}/public/*'] + [
        f'arn:aws:s3:::{private}/{prefix}/*' for prefix in ('staging', 'private', 'kyc')
    ]
    policy = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], 'Resource': object_arns},
        {'Effect': 'Allow', 'Action': 's3:AbortMultipartUpload', 'Resource': f'arn:aws:s3:::{private}/private/*'},
        {'Effect': 'Allow', 'Action': 's3:ListBucket', 'Resource': [f'arn:aws:s3:::{media}', f'arn:aws:s3:::{private}']},
    ]}
    source = dict(os.environ)
    for key in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        source.pop(key, None)
    result = subprocess.run(['aws', 'sts', 'get-federation-token', '--profile', 'default', '--region', region, '--name', 'delivery-s3', '--duration-seconds', '3600', '--policy', json.dumps(policy, separators=(',', ':')), '--output', 'json'], env=source, capture_output=True, check=True, text=True, timeout=30)
    creds = json.loads(result.stdout)['Credentials']
    print(json.dumps({'Version': 1, 'AccessKeyId': creds['AccessKeyId'], 'SecretAccessKey': creds['SecretAccessKey'], 'SessionToken': creds['SessionToken'], 'Expiration': creds['Expiration']}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Unable to obtain the restricted S3 session', file=sys.stderr)
        sys.exit(1)
