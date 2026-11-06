const common = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      testTimeout: 15000,
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      testTimeout: 120000,
    },
    {
      ...common,
      displayName: 'concurrency',
      testMatch: ['<rootDir>/test/concurrency/**/*.spec.ts'],
      testTimeout: 120000,
    },
    {
      ...common,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
      testTimeout: 120000,
    },
  ],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/modules/**/domain/**/*.ts', 'src/modules/**/application/**/*.ts'],
  coverageThreshold: {
    'src/modules/**/domain/**/*.ts': { lines: 85 },
    'src/modules/**/application/**/*.ts': { lines: 85 },
  },
};
