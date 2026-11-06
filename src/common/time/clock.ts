export interface Clock {
  now(): Date;
}
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
export class FixedClock implements Clock {
  constructor(private current: Date) {
    this.current = new Date(current);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(value: Date): void {
    this.current = new Date(value);
  }
}
