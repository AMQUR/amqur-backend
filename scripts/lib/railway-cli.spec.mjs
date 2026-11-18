import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RAILWAY_FAILURE,
  asVariables,
  classifyRailwayFailure,
  describeRailwayFailure,
  railwayCliVersion,
  readRailwayVariables,
} from './railway-cli.mjs';

const SECRET = 'sk-live-THIS-MUST-NEVER-BE-PRINTED';

function cliError(stderr, status = 1) {
  return Object.assign(new Error('Command failed'), { stderr, status });
}

test('rejected token is UNAUTHORIZED (wording printed by railway CLI 5.75)', () => {
  const result = classifyRailwayFailure(
    cliError(
      "Unauthorized. Please check that your RAILWAY_API_TOKEN is valid and has access to the resource you're trying to use.",
    ),
  );
  assert.equal(result.category, RAILWAY_FAILURE.UNAUTHORIZED);
  assert.equal(result.exitStatus, 1);
  assert.match(result.hint, /repository secret/);
});

test('each failure mode maps to its own category', () => {
  const cases = [
    [Object.assign(new Error('spawn'), { code: 'ENOENT' }), 'CLI_NOT_FOUND'],
    [Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), 'TIMEOUT'],
    [Object.assign(new Error('t'), { killed: true }), 'TIMEOUT'],
    [cliError("You don't have the required role (viewer) on this resource."), 'FORBIDDEN'],
    [cliError('Service "apii" not found'), 'NOT_FOUND'],
    [cliError('Environment does not exist'), 'NOT_FOUND'],
    [cliError('Too Many Requests'), 'RATE_LIMITED'],
    [cliError("error: unexpected argument '--project' found"), 'CLI_USAGE'],
    [cliError('error sending request: dns error'), 'NETWORK'],
    [cliError('502 Bad Gateway'), 'NETWORK'],
    [new SyntaxError('Unexpected token < in JSON'), 'INVALID_OUTPUT'],
    [new Error('invalid format'), 'INVALID_OUTPUT'],
    [cliError('something nobody anticipated'), 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyRailwayFailure(error).category, expected);
  }
});

test('description never echoes stderr, stdout or the error message', () => {
  const error = Object.assign(new Error(`boom ${SECRET}`), {
    stderr: `Unauthorized ${SECRET}`,
    stdout: `{"KEY":"${SECRET}"}`,
    status: 1,
  });
  const line = describeRailwayFailure(error);
  assert.ok(!line.includes(SECRET));
  assert.match(line, /^category=UNAUTHORIZED exit=1 — /);
});

test('asVariables accepts flat, wrapped and array shapes', () => {
  assert.deepEqual(asVariables({ A: '1' }), { A: '1' });
  assert.deepEqual(asVariables({ data: { variables: { A: '1' } } }), { A: '1' });
  assert.deepEqual(
    asVariables([{ name: 'A', value: '1' }, { key: 'B', value: '2' }]),
    { A: '1', B: '2' },
  );
  assert.throws(() => asVariables([{ value: 'no name' }]), /invalid format/);
  assert.throws(() => asVariables('nope'), /invalid format/);
});

test('readRailwayVariables passes the expected arguments and parses output', () => {
  const calls = [];
  const exec = (bin, args, options) => {
    calls.push({ bin, args, options });
    return JSON.stringify({ CORS_ORIGINS: 'https://a.example' });
  };
  const vars = readRailwayVariables(
    { projectId: 'p1', service: 'api', environment: 'staging' },
    exec,
  );
  assert.deepEqual(vars, { CORS_ORIGINS: 'https://a.example' });
  assert.equal(calls[0].bin, 'railway');
  assert.deepEqual(calls[0].args, [
    'variables', '--project', 'p1', '--service', 'api',
    '--environment', 'staging', '--json',
  ]);
  assert.equal(calls[0].options.timeout, 90_000);
  // stdout/stderr are captured, never inherited into the job log.
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('non-JSON output is classified INVALID_OUTPUT, not swallowed', () => {
  const exec = () => '<html>login</html>';
  let caught;
  try {
    readRailwayVariables({ projectId: 'p', service: 's', environment: 'e' }, exec);
  } catch (error) {
    caught = error;
  }
  assert.equal(classifyRailwayFailure(caught).category, 'INVALID_OUTPUT');
});

test('railwayCliVersion degrades to "unavailable"', () => {
  assert.equal(railwayCliVersion(() => 'railway 5.75.0\n'), 'railway 5.75.0');
  assert.equal(
    railwayCliVersion(() => {
      throw new Error('x');
    }),
    'unavailable',
  );
});
