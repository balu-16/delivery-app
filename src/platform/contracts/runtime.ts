/** Runtime infrastructure tokens. Feature code should depend on its own ports. */
export const PLATFORM_DATABASE = Symbol('PLATFORM_DATABASE');
export const PLATFORM_REDIS = Symbol('PLATFORM_REDIS');
export const PLATFORM_QUEUE = Symbol('PLATFORM_QUEUE');
export const PLATFORM_CONCERN_QUEUES = Symbol('PLATFORM_CONCERN_QUEUES');
