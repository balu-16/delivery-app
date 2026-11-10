/** Runtime infrastructure tokens. Feature code should depend on its own ports. */
export const PLATFORM_DATABASE = Symbol('PLATFORM_DATABASE');
export const PLATFORM_REDIS = Symbol('PLATFORM_REDIS');
export const PLATFORM_REALTIME_REDIS = Symbol('PLATFORM_REALTIME_REDIS');
export const PLATFORM_QUEUE = Symbol('PLATFORM_QUEUE');
export const PLATFORM_CONCERN_QUEUES = Symbol('PLATFORM_CONCERN_QUEUES');
export const PLATFORM_SQS = Symbol('PLATFORM_SQS');
export const REALTIME_GATEWAY = Symbol('REALTIME_GATEWAY');
