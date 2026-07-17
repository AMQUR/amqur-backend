module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/worker.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // Global floor = anti-regression. Critical modules enforce stronger gates.
  coverageThreshold: {
    global: {
      branches: 18,
      functions: 20,
      lines: 20,
      statements: 20,
    },
    './src/feature-flags/feature-flags.service.ts': {
      branches: 60,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/capability/capability.service.ts': {
      branches: 55,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    './src/common/types/public-branding.ts': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/integrations/core/circuit-breaker.service.ts': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/chat/engines/inventory-freshness.ts': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
