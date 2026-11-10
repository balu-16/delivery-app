import type { AppConfig } from '../../app-config/contracts/config.js';
import {
  isDispatchTrigger,
  type DispatchDefaultKey,
  type DispatchTrigger,
} from '../domain/settings.js';

/** Typed app_config reads; invalid or unavailable configuration propagates. */
export class DispatchSettings {
  constructor(private readonly config: AppConfig) {}
  async number(key: DispatchDefaultKey): Promise<number> {
    const value = await this.config.get(key);
    if (typeof value !== 'number') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
  async paise(key: DispatchDefaultKey): Promise<string> {
    const value = await this.config.get(key);
    if (typeof value !== 'string') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
  async string(key: DispatchDefaultKey): Promise<string> {
    const value = await this.config.get(key);
    if (typeof value !== 'string') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
  async wideningSteps(): Promise<number[]> {
    return this.config.get('dispatchRadiusWideningStepsM');
  }
  async weights(): Promise<{ eta: number; idle: number; acceptance: number }> {
    const [eta, idle, acceptance] = await Promise.all([
      this.number('dispatchScoreWeightsEta'),
      this.number('dispatchScoreWeightsIdle'),
      this.number('dispatchScoreWeightsAcceptance'),
    ]);
    return { eta, idle, acceptance };
  }
  async trigger(): Promise<DispatchTrigger> {
    const value = await this.string('dispatchTrigger');
    return isDispatchTrigger(value) ? value : 'ON_PICK_START';
  }
}
