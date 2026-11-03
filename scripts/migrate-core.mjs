// Copies DataTransfer data from one Supabase Postgres to another, keeping every UUID.
// Keeping ids matters: messages and wrapped room keys are cryptographically bound to the user and room ids,
// so re-creating accounts would make existing history undecryptable.
//
// `old` and `target` are anything with `query(sql, params) -> { rows }` (pg.Client, PGlite).

/** Parents before children, so foreign keys hold. push_tokens and lookup_log are deliberately skipped:
 *  device tokens belong to the old Firebase/app install and devices re-register on next launch. */
export const TABLES = [
  { name: 'auth.users', pk: ['id'] },
  { name: 'auth.identities', pk: ['id'] },
  { name: 'public.profiles', pk: ['id'] },
  { name: 'public.projects', pk: ['id'] },
  { name: 'public.chats', pk: ['id'] },
  { name: 'public.project_members', pk: ['project_id', 'user_id'] },
  { name: 'public.rooms', pk: ['id'] },
  { name: 'public.room_members', pk: ['room_id', 'user_id', 'key_version'] },
  { name: 'public.messages', pk: ['id'] },
]

const BATCH = 100
const q = (ident) => `"${ident.replace(/"/g, '""')}"`
const qt = (table) => table.split('.').map(q).join('.')
const affected = (r) => r.rowCount ?? r.affectedRows ?? 0

/** Writable columns (generated and GENERATED ALWAYS identity columns can't be inserted into). */
async function columns(c, table) {
  const [schema, name] = table.split('.')
  const { rows } = await c.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, a.atthasdef as hasdef
       from pg_attribute a
       join pg_class k on k.oid = a.attrelid
       join pg_namespace n on n.oid = k.relnamespace
      where n.nspname = $1 and k.relname = $2 and k.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity <> 'a'
      order by a.attnum`,
    [schema, name],
  )
  return rows
}

const count = async (c, table) => Number((await c.query(`select count(*) as n from ${qt(table)}`)).rows[0].n)

/** Read-only inspection. Returns a report; `errors` must be empty before applying. */
export async function plan(old, target) {
  const report = { tables: [], errors: [], warnings: [] }

  for (const t of TABLES) {
    const oc = await columns(old, t.name)
    const nc = await columns(target, t.name)
    const row = { table: t.name, oldRows: 0, newRows: 0, copyColumns: [] }
    report.tables.push(row)

    if (oc.length === 0) {
      report.warnings.push(`${t.name}: not in the old database, skipped`)
      continue
    }
    if (nc.length === 0) {
      report.errors.push(`${t.name}: missing in the NEW database. Run supabase/setup_all.sql there first.`)
      continue
    }
    const newNames = new Set(nc.map((c) => c.name))
    const oldNames = new Set(oc.map((c) => c.name))
    const lost = oc.filter((c) => !newNames.has(c.name)).map((c) => c.name)
    if (lost.length) report.warnings.push(`${t.name}: columns only in old, not copied: ${lost.join(', ')}`)
    const required = nc.filter((c) => c.notnull && !c.hasdef && !oldNames.has(c.name)).map((c) => c.name)
    if (required.length) report.errors.push(`${t.name}: new database requires columns the old one lacks: ${required.join(', ')}`)
    for (const k of t.pk) if (!newNames.has(k) || !oldNames.has(k)) report.errors.push(`${t.name}: key column ${k} missing on one side`)

    row.copyColumns = oc.filter((c) => newNames.has(c.name))
    row.oldRows = await count(old, t.name)
    row.newRows = await count(target, t.name)
  }

  if (report.errors.length === 0) {
    // Same person, different id would make the account unusable: block it.
    const ou = (await old.query(`select id::text as id, lower(email) as email from auth.users`)).rows
    const nu = (await target.query(`select id::text as id, lower(email) as email from auth.users`)).rows
    const byEmail = new Map(nu.map((u) => [u.email, u.id]))
    const newIds = new Set(nu.map((u) => u.id))
    report.alreadyThere = ou.filter((u) => newIds.has(u.id)).length
    for (const u of ou) {
      const other = u.email && byEmail.get(u.email)
      if (other && other !== u.id) report.errors.push(`email ${u.email} exists in both databases with DIFFERENT ids (delete the test account in the new one)`)
    }
    const op = (await old.query(`select id::text as id, lower(username) as username from public.profiles`)).rows
    const np = (await target.query(`select id::text as id, lower(username) as username from public.profiles`)).rows
    const byName = new Map(np.map((p) => [p.username, p.id]))
    for (const p of op) {
      const other = byName.get(p.username)
      if (other && other !== p.id) report.errors.push(`username ${p.username} exists in both databases with DIFFERENT ids`)
    }
  }
  return report
}

async function copyTable(old, target, t, cols) {
  // Everything travels as text and is cast back to the column's real type, so timestamps keep microseconds
  // and jsonb/citext/arrays survive untouched.
  const sel = cols.map((c) => `${q(c.name)}::text as ${q(c.name)}`).join(', ')
  const rows = (await old.query(`select ${sel} from ${qt(t.name)}`)).rows
  const colList = cols.map((c) => q(c.name)).join(', ')
  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const params = []
    const tuples = chunk.map((r) => {
      const ph = cols.map((c) => {
        params.push(r[c.name])
        return `$${params.length}::${c.type}`
      })
      return `(${ph.join(', ')})`
    })
    const res = await target.query(`insert into ${qt(t.name)} (${colList}) values ${tuples.join(', ')} on conflict do nothing`, params)
    inserted += affected(res)
  }
  return { read: rows.length, inserted }
}

/** Copies everything in one transaction on the target, then checks every old key exists there. */
export async function apply(old, target, report) {
  if (report.errors.length) throw new Error('Refusing to apply: ' + report.errors.join('; '))
  const results = []
  await target.query('begin')
  try {
    for (const t of TABLES) {
      const row = report.tables.find((r) => r.table === t.name)
      if (!row || row.copyColumns.length === 0) continue
      results.push({ table: t.name, ...(await copyTable(old, target, t, row.copyColumns)) })
    }

    const missing = []
    for (const t of TABLES) {
      const row = report.tables.find((r) => r.table === t.name)
      if (!row || row.copyColumns.length === 0) continue
      const key = t.pk.map((k) => `${q(k)}::text`).join(` || '|' || `)
      const oldKeys = (await old.query(`select ${key} as k from ${qt(t.name)}`)).rows.map((r) => r.k)
      const newKeys = new Set((await target.query(`select ${key} as k from ${qt(t.name)}`)).rows.map((r) => r.k))
      const gone = oldKeys.filter((k) => !newKeys.has(k))
      if (gone.length) missing.push(`${t.name}: ${gone.length} rows did not arrive (e.g. ${gone[0]})`)
    }
    if (missing.length) throw new Error('Verification failed, nothing was written. ' + missing.join('; '))
    await target.query('commit')
  } catch (e) {
    await target.query('rollback')
    throw e
  }
  return results
}
