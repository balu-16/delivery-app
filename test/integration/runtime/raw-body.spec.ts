import 'reflect-metadata';
import { Body, Controller, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import rawBody from 'fastify-raw-body';

@Controller()
class RawBodyFixtureController {
  @Post('normal') normal(@Body() body: unknown, @Req() request: FastifyRequest): unknown {
    return { body, hasRawBody: request.rawBody !== undefined };
  }
  @Post('webhook') webhook(@Body() body: unknown, @Req() request: FastifyRequest): unknown {
    return {
      body,
      raw: Buffer.isBuffer(request.rawBody) ? request.rawBody.toString('utf8') : null,
    };
  }
}
@Module({ controllers: [RawBodyFixtureController] })
class RawBodyFixtureModule {}

describe('webhook-scoped Nest Fastify raw body capability', () => {
  it('retains exact bytes for the webhook fixture only', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      RawBodyFixtureModule,
      new FastifyAdapter(),
      { logger: false, bodyParser: false },
    );
    await app.register(rawBody, {
      global: false,
      routes: ['/webhook'],
      encoding: false,
      runFirst: true,
    });
    await app.init();
    const server = app.getHttpAdapter().getInstance();
    await server.ready();
    try {
      const payload = '{ "value" : 1 }';
      const normal = await server.inject({
        method: 'POST',
        url: '/normal',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      const webhook = await server.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(normal.json()).toEqual({ body: { value: 1 }, hasRawBody: false });
      expect(webhook.json()).toEqual({ body: { value: 1 }, raw: payload });
    } finally {
      await app.close();
    }
  });
});
