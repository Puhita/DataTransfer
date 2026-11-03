// .env-style text <-> secrets. Plain, dotenv-compatible subset:
//   NAME=value            unquoted: trimmed, " #comment" stripped
//   NAME="a b\nc"         double quotes: \n \r \\ \" are expanded, may span lines
//   NAME='literal'        single quotes: literal, may span lines
//   # comment, blank lines, optional `export ` prefix
// No $VAR expansion. The same rules are used to write text (formatValue) and to read it back (parseEnv).

export interface EnvEntry {
  name: string
  value: string
}

export interface ParseResult {
  entries: EnvEntry[]
  /** Lines we could not understand. Saving is blocked until they are fixed, so nothing is dropped silently. */
  problems: string[]
  /** Names that appear more than once (the last one wins). */
  duplicates: string[]
}

const NAME = /^[A-Za-z0-9_.-]+$/
export const MAX_NAME = 120

/** Names that can be written as NAME=value (a secret named "my key" can only live in the card list). */
export const isEnvName = (n: string): boolean => n.length > 0 && n.length <= MAX_NAME && NAME.test(n)

export function formatValue(v: string): string {
  if (v === '' || !/[\s#"'\\]/.test(v)) return v
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

export const serializeEnv = (entries: EnvEntry[]): string => entries.map((e) => `${e.name}=${formatValue(e.value)}`).join('\n')

export function parseEnv(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const byName = new Map<string, string>()
  const problems: string[] = []
  const duplicates: string[] = []
  let i = 0

  while (i < lines.length) {
    const lineNo = i + 1
    const line = lines[i++]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const m = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=(.*)$/.exec(line)
    if (!m) {
      problems.push(`Line ${lineNo}: expected NAME=value`)
      continue
    }
    const name = m[1]
    if (name.length > MAX_NAME) {
      problems.push(`Line ${lineNo}: the name is longer than ${MAX_NAME} characters`)
      continue
    }
    const rest = m[2].replace(/^\s+/, '')
    const quote = rest[0]
    let value: string

    if (quote === '"' || quote === "'") {
      let buf = rest.slice(1)
      let out = ''
      let end = -1
      for (;;) {
        let j = 0
        while (j < buf.length) {
          const ch = buf[j]
          if (quote === '"' && ch === '\\' && j + 1 < buf.length) {
            const n = buf[j + 1]
            if (n === 'n') out += '\n'
            else if (n === 'r') out += '\r'
            else if (n === '\\' || n === '"') out += n
            else out += ch + n // any other backslash stays as written, e.g. C:\temp
            j += 2
            continue
          }
          if (ch === quote) {
            end = j
            break
          }
          out += ch
          j++
        }
        if (end >= 0 || i >= lines.length) break
        out += '\n'
        buf = lines[i++]
      }
      if (end < 0) {
        problems.push(`Line ${lineNo}: the quote is never closed`)
        continue
      }
      const tail = buf.slice(end + 1).trim()
      if (tail && !tail.startsWith('#')) {
        problems.push(`Line ${lineNo}: unexpected text after the closing quote`)
        continue
      }
      value = out
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }

    if (byName.has(name)) duplicates.push(name)
    byName.set(name, value)
  }

  return { entries: [...byName].map(([name, value]) => ({ name, value })), problems, duplicates }
}

export interface Existing extends EnvEntry {
  id: string
  notes?: string
}

export interface Plan {
  add: EnvEntry[]
  change: { entry: EnvEntry; old: Existing }[]
  unchanged: number
}

/** `existing` must be newest first. A name that exists more than once is compared against its newest version. */
export function planChanges(existing: Existing[], next: EnvEntry[]): Plan {
  const newest = new Map<string, Existing>()
  for (const e of existing) if (!newest.has(e.name)) newest.set(e.name, e)
  const plan: Plan = { add: [], change: [], unchanged: 0 }
  for (const entry of next) {
    const old = newest.get(entry.name)
    if (!old) plan.add.push(entry)
    else if (old.value !== entry.value) plan.change.push({ entry, old })
    else plan.unchanged++
  }
  return plan
}
