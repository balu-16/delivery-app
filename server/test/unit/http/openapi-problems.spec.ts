import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { makeOpenApiDocument } from '../../../src/common/http/openapi.js';

it('publishes safe current domain codes and the actual problem media type', async () => {
  const app = await createApplication(
    readEnv({ NODE_ENV: 'test', APP_ROLE: 'customer', LOG_LEVEL: 'silent' }),
    [],
  );
  try {
    const doc = makeOpenApiDocument(app, 'customer');
    const conflict = doc.components?.schemas?.['Problem409'];
    expect(conflict && !('$ref' in conflict) && conflict.properties?.['code']).toMatchObject({
      enum: expect.arrayContaining([
        'CUTOFF_PASSED',
        'IDEMPOTENCY_KEY_REUSED',
        'SUBSCRIPTIONS_DISABLED',
      ]),
    });
    const operation = doc.paths['/v1/customer/subscriptions']?.post;
    expect(operation?.responses['409']).toMatchObject({
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem409' } },
      },
    });
    expect(doc.paths['/v1/customer/webhooks/payments/{gateway}']?.post?.security).toEqual([]);
    const createAddress = doc.paths['/v1/customer/addresses']?.post?.requestBody;
    expect(
      createAddress &&
        !('$ref' in createAddress) &&
        createAddress.content?.['application/json']?.schema,
    ).toEqual({
      $ref: '#/components/schemas/CustomerAddressDto',
    });
    const addressSchema = doc.components?.schemas?.['CustomerAddressDto'];
    expect(addressSchema && !('$ref' in addressSchema) && addressSchema.required).toEqual(
      expect.arrayContaining(['line1', 'pincode', 'contactName', 'contactPhone', 'lat', 'lng']),
    );
    const changeAddress = doc.paths['/v1/customer/orders/{orderId}/address']?.patch?.requestBody;
    expect(
      changeAddress &&
        !('$ref' in changeAddress) &&
        changeAddress.content?.['application/json']?.schema,
    ).toEqual({
      $ref: '#/components/schemas/ChangeOrderAddressDto',
    });
  } finally {
    await app.close();
  }
});
