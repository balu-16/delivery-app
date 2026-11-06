import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { type Surface, surfaceModules, surfacesFor } from '../../app-roles/roles.js';
import type { Env } from '../../config/env.schema.js';

/** Build a per-audience OpenAPI 3.1 document. */
export function makeOpenApiDocument(app: INestApplication, surface: Surface): OpenAPIObject {
  const options = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle(`Delivery ${surface} API`)
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, options, {
    include: [surfaceModules[surface]],
    deepScanRoutes: true,
  });
}

/** Production docs are disabled until authentication is available. */
export function registerOpenApi(app: INestApplication, env: Env): void {
  if (env.NODE_ENV === 'production') return;
  for (const surface of surfacesFor(env.APP_ROLE)) {
    const document = makeOpenApiDocument(app, surface);
    SwaggerModule.setup(`v1/${surface}/docs`, app, document);
  }
}
