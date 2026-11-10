# 0001: P0 toolchain and module boundaries

Date: 6 November 2026. Status: accepted for implementation.

## Context

The source requires the current Active LTS Node release, latest stable Nest/Fastify, strict TypeScript, pnpm, Kysely/plain SQL migrations, Jest/Testcontainers and hard module boundaries. The machine starts with Node 24 and no pnpm. Dependencies and a writable Git repository are not preconfigured.

## Decision

Pin Node 26.13.0, pnpm 12.18.0, Nest 12.4.0, Fastify 5.12.8, Swagger 12.1.1 and TypeScript 6.0.3. Resolve exact package versions into package.json/pnpm-lock.yaml. Nest Swagger and ts-jest's declared peers exclude TypeScript 7; use their compatible TypeScript 6 line. Use native ESM with NodeNext resolution and `.js` source import specifiers. Use patched Zod 4.6.7: dependency audit identified a high-severity constrained-collection issue in the initially selected Zod 3.25.76; migrate the schema types and keep the high-severity CI gate enabled.

Use the TypeScript compiler for application builds/dev restarts so Nest decorator metadata is emitted. `tsx` is used only for non-Nest migration/seed tooling. Jest uses ts-jest's ESM transformation and Node VM-module support. OpenAPI export imports compiled code and validates actual schemas.

Dependency purposes: Nest/Fastify and validation implement the fixed HTTP stack; Kysely/pg/node-pg-migrate implement typed PostgreSQL and one SQL migration runner; ioredis/BullMQ implement disposable transport plus durable DB-backed obligations; Node cryptographic primitives implement UUIDv7 without an additional package; pino provides structured redaction; AWS Cognito SDK/aws-jwt-verify/jose implement real/local P1 identity; Testcontainers/Jest/supertest cover real service and API behavior; Swagger Parser validates exported OpenAPI; ESLint/TypeScript AST boundaries/Prettier enforce code quality. Husky/lint-staged run the pre-commit quality checks in the initialized repository. `fastify-raw-body` tests selective webhook byte preservation.

Explicitly deny optional telemetry/native postinstall scripts that are unnecessary for these flows. Allow esbuild's published platform binary setup for `tsx`; record all build choices in pnpm-workspace.yaml. Keep pnpm's lockfile supply-chain checks enabled. Reviewed Nest release-age exceptions are explicit, not a blanket policy disable.

Allow provider-only module imports in composition/wiring files; all cross-domain application imports use contracts. Audience controllers stay separate from provider-only modules. Never use a root sibling import as a substitute for Nest's actual provider visibility rules.

## Consequences

Toolchain binaries installed under `/tmp/delivery-toolchain` support this session without changing global tools. Local checks and Docker builds must use the pinned runtime. The initial environment exposed a protected Git placeholder. After full workspace permissions became available, the placeholder was absent and the parent initialized a normal repository on `main`. Small reviewed Conventional Commits record the implementation; local credentials and generated artifacts are excluded.

The exact dependency graph is the lockfile. [Node's release schedule](https://github.com/nodejs/Release), official package metadata, [Nest modules](https://docs.nestjs.com/modules) and [ts-jest ESM guidance](https://kulshekhar.github.io/ts-jest/docs/guides/esm-support) informed compatibility; passing checks, not version numbers alone, establish acceptance.
