import { isValidSessionName } from '@ecc/shared';

describe('isValidSessionName', () => {
  it.each(['a', 'payroll', 'Payroll-2_b', '0', 'a'.repeat(64)])('accepts %s', (name) => {
    expect(isValidSessionName(name)).toBe(true);
  });

  it.each([
    '',
    'a'.repeat(65),
    '-flag',
    '_leading',
    'has space',
    'a:b',
    'a.b',
    '=exact',
    'a;kill-server',
    'a$(id)',
    'a`id`',
    '#{pane_pid}',
    '../etc',
    'a\nb',
    'a\0',
    'ñandú',
  ])('rejects %j', (name) => {
    expect(isValidSessionName(name)).toBe(false);
  });

  it.each([null, undefined, 5, {}, ['a']])('rejects non-string %j', (name) => {
    expect(isValidSessionName(name)).toBe(false);
  });
});
