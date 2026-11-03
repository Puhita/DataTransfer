import { describe, expect, it } from 'vitest'
import { formatValue, isEnvName, parseEnv, planChanges, serializeEnv, type Existing } from './envText'

const values = (t: string) => Object.fromEntries(parseEnv(t).entries.map((e) => [e.name, e.value]))

describe('parseEnv', () => {
  it('reads plain pairs, comments, blank lines and export', () => {
    const r = parseEnv('# header\n\nA=1\nexport B = two words # trailing\n  C=\n')
    expect(r.problems).toEqual([])
    expect(values('# header\n\nA=1\nexport B = two words # trailing\n  C=\n')).toEqual({ A: '1', B: 'two words', C: '' })
  })

  it('keeps = # and URL characters inside unquoted values', () => {
    expect(values('K=abc==\nU=https://x.dev/a?b=1&c=2\nH=a#b')).toEqual({ K: 'abc==', U: 'https://x.dev/a?b=1&c=2', H: 'a#b' })
  })

  it('handles double quotes with escapes and multi-line values', () => {
    expect(values('A="x y"\nB="line1\\nline2"\nC="say \\"hi\\" \\\\ ok"\nD="one\ntwo"')).toEqual({
      A: 'x y',
      B: 'line1\nline2',
      C: 'say "hi" \\ ok',
      D: 'one\ntwo',
    })
  })

  it('keeps other backslashes as written (Windows paths) and treats single quotes literally', () => {
    expect(values(`P="C:\\temp\\x"\nS='a\\nb $HOME'`)).toEqual({ P: 'C:\\temp\\x', S: 'a\\nb $HOME' })
  })

  it('allows a comment after a closing quote', () => {
    expect(values('A="v" # why')).toEqual({ A: 'v' })
  })

  it('reports lines it cannot read instead of dropping them', () => {
    const r = parseEnv('GOOD=1\nthis is not a pair\nBAD="never closed\nstill open')
    expect(r.problems).toEqual(['Line 2: expected NAME=value', 'Line 3: the quote is never closed'])
    const t = parseEnv('A="v" junk')
    expect(t.problems[0]).toMatch(/after the closing quote/)
  })

  it('last duplicate wins and is reported', () => {
    const r = parseEnv('A=1\nB=2\nA=3')
    expect(r.entries).toEqual([{ name: 'A', value: '3' }, { name: 'B', value: '2' }])
    expect(r.duplicates).toEqual(['A'])
  })

  it('accepts names like .env.staging and rejects over-long ones', () => {
    expect(values('.env.staging=x')).toEqual({ '.env.staging': 'x' })
    expect(parseEnv(`${'A'.repeat(121)}=x`).problems).toHaveLength(1)
  })

  it('handles Windows line endings', () => {
    expect(values('A=1\r\nB="x\r\ny"\r\n')).toEqual({ A: '1', B: 'x\ny' })
  })
})

describe('serialize / round trip', () => {
  const nasty = [
    '',
    'plain',
    'has space',
    'has # hash',
    'say "hi"',
    "it's",
    'back\\slash',
    'two\nlines',
    'trailing newline\n',
    'cr\r\nlf',
    '  padded  ',
    'tab\there',
    '"starts with quote',
    'ünïcødé 🔑',
    'KEY=inside=value',
    '-----BEGIN KEY-----\nabc\n-----END KEY-----',
  ]

  it('every tricky value survives write then read', () => {
    const entries = nasty.map((value, i) => ({ name: `K${i}`, value }))
    const back = parseEnv(serializeEnv(entries))
    expect(back.problems).toEqual([])
    expect(back.entries.map((e) => e.value)).toEqual(nasty)
  })

  it('only quotes when it has to', () => {
    expect(formatValue('abc123')).toBe('abc123')
    expect(formatValue('')).toBe('')
    expect(formatValue('a b')).toBe('"a b"')
    expect(formatValue('a\nb')).toBe('"a\\nb"')
  })

  it('isEnvName', () => {
    expect(isEnvName('STRIPE_KEY')).toBe(true)
    expect(isEnvName('.env.staging')).toBe(true)
    expect(isEnvName('my key')).toBe(false)
    expect(isEnvName('')).toBe(false)
  })
})

describe('planChanges', () => {
  const ex = (id: string, name: string, value: string, notes?: string): Existing => ({ id, name, value, notes })

  it('splits into add, change and unchanged, and never removes', () => {
    const existing = [ex('1', 'A', 'a'), ex('2', 'B', 'b', 'note'), ex('3', 'GONE', 'g')]
    const p = planChanges(existing, [{ name: 'A', value: 'a' }, { name: 'B', value: 'B2' }, { name: 'C', value: 'c' }])
    expect(p.unchanged).toBe(1)
    expect(p.add).toEqual([{ name: 'C', value: 'c' }])
    expect(p.change).toEqual([{ entry: { name: 'B', value: 'B2' }, old: existing[1] }])
  })

  it('compares against the newest version when a name exists twice (newest first)', () => {
    const p = planChanges([ex('new', 'A', 'v2'), ex('old', 'A', 'v1')], [{ name: 'A', value: 'v2' }])
    expect(p.unchanged).toBe(1)
    expect(p.change).toEqual([])
  })
})
