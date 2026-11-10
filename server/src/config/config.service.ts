import { Injectable } from '@nestjs/common';
import type { Env } from './env.schema.js';

/** Immutable configuration, parsed once by the composition root. */
@Injectable()
export class ConfigService {
  constructor(private readonly env: Env) {}
  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }
}
