// Tests for the parseEnvText function used by the "Paste .env" feature in app.js.
// The function is copied here verbatim so the test has no browser DOM dependency.
function parseEnvText(text) {
  const result = {};
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  });
  return result;
}

describe('parseEnvText', () => {
  test('parses basic KEY=value pairs', () => {
    expect(parseEnvText('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('strips double-quoted values', () => {
    expect(parseEnvText('API_KEY="my-secret"')).toEqual({ API_KEY: 'my-secret' });
  });

  test('strips single-quoted values', () => {
    expect(parseEnvText("TOKEN='abc123'")).toEqual({ TOKEN: 'abc123' });
  });

  test('skips comment lines', () => {
    expect(parseEnvText('# this is a comment\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('skips blank lines', () => {
    expect(parseEnvText('\n\nFOO=bar\n\n')).toEqual({ FOO: 'bar' });
  });

  test('skips lines without =', () => {
    expect(parseEnvText('NOEQUALS\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('allows empty values', () => {
    expect(parseEnvText('EMPTY=')).toEqual({ EMPTY: '' });
  });

  test('value may contain = signs', () => {
    expect(parseEnvText('URL=http://x.com?a=1&b=2')).toEqual({ URL: 'http://x.com?a=1&b=2' });
  });

  test('returns empty object for empty input', () => {
    expect(parseEnvText('')).toEqual({});
  });

  test('handles full .env block', () => {
    const input = [
      '# DB config',
      'DB_HOST=localhost',
      'DB_PORT=5432',
      'API_KEY="my-secret-key"',
      'DEBUG=true',
    ].join('\n');
    expect(parseEnvText(input)).toEqual({
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      API_KEY: 'my-secret-key',
      DEBUG: 'true',
    });
  });
});
