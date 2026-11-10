import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityAdmin } from '../../../src/adapters/auth/cognito.js';

test('Cognito admin translates all port operations to the documented pool and username commands', async () => {
  const commands: Array<{ input: unknown }> = [];
  const client = {
    send: async (command: { input: unknown }) => {
      commands.push(command);
      if (command instanceof AdminCreateUserCommand)
        return { User: { Attributes: [{ Name: 'sub', Value: 'remote-sub' }] } };
      if (command instanceof AdminGetUserCommand)
        return { UserAttributes: [{ Name: 'sub', Value: 'remote-sub' }] };
      return {};
    },
  } as unknown as CognitoIdentityProviderClient;
  const adapter = new CognitoIdentityAdmin(client, 'pool');
  expect(await adapter.create('opaque-operation', 'test@example.test', 'Test')).toEqual({
    sub: 'remote-sub',
  });
  expect(await adapter.find('opaque-operation')).toEqual({ sub: 'remote-sub' });
  await adapter.addToGroup('opaque-operation', 'RIDER');
  await adapter.removeFromGroup('opaque-operation', 'RIDER');
  await adapter.disable('opaque-operation');
  await adapter.enable('opaque-operation');
  await adapter.forcePasswordReset('opaque-operation');
  await adapter.delete('opaque-operation');
  expect(commands.map((c) => c.constructor)).toEqual([
    AdminCreateUserCommand,
    AdminGetUserCommand,
    AdminAddUserToGroupCommand,
    AdminRemoveUserFromGroupCommand,
    AdminDisableUserCommand,
    AdminEnableUserCommand,
    AdminResetUserPasswordCommand,
    AdminDeleteUserCommand,
  ]);
  for (const command of commands)
    expect(command.input).toMatchObject({ UserPoolId: 'pool', Username: 'opaque-operation' });
  expect(commands[0]?.input).toMatchObject({
    UserAttributes: [
      { Name: 'email', Value: 'test@example.test' },
      { Name: 'name', Value: 'Test' },
    ],
    DesiredDeliveryMediums: ['EMAIL'],
  });
  expect(commands[2]?.input).toMatchObject({ GroupName: 'RIDER' });
});
