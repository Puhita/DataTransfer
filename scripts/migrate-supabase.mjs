// Usage (PowerShell):
//   $env:OLD_DB_URL = "postgresql://postgres.<oldref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
//   $env:NEW_DB_URL = "postgresql://postgres.<newref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
//   node scripts/migrate-supabase.mjs            # dry run: reads both, changes nothing
//   node scripts/migrate-supabase.mjs --apply    # copies into the NEW database
//
// Use the *Session pooler* connection string from Supabase -> Connect (the direct host is IPv6-only on the free plan).
// URL-encode special characters in the password. Never commit these strings. The OLD database is only ever read.
import pg from 'pg'
import { apply, plan } from './migrate-core.mjs'

const { OLD_DB_URL, NEW_DB_URL } = process.env
if (!OLD_DB_URL || !NEW_DB_URL) {
  console.error('Set OLD_DB_URL and NEW_DB_URL first (see the header of this file).')
  process.exit(2)
}
if (OLD_DB_URL === NEW_DB_URL) {
  console.error('OLD_DB_URL and NEW_DB_URL are the same database. Refusing.')
  process.exit(2)
}

const connect = async (url) => {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  return c
}

const old = await connect(OLD_DB_URL)
const target = await connect(NEW_DB_URL)
// belt and braces: the old database cannot be modified by this script
await old.query('set default_transaction_read_only = on')

try {
  const report = await plan(old, target)
  console.log('\nTable                      old rows   new rows')
  for (const t of report.tables) console.log(`${t.table.padEnd(26)} ${String(t.oldRows).padStart(8)}   ${String(t.newRows).padStart(8)}`)
  if (report.alreadyThere !== undefined) console.log(`\nUsers already in the new database (same id): ${report.alreadyThere}`)
  for (const w of report.warnings) console.log('warning:', w)
  for (const e of report.errors) console.log('ERROR:  ', e)

  if (report.errors.length) {
    process.exitCode = 1
  } else if (!process.argv.includes('--apply')) {
    console.log('\nDry run only. Nothing was written. Re-run with --apply to copy.')
  } else {
    const res = await apply(old, target, report)
    console.log('\nCopied (rows read / newly inserted):')
    for (const r of res) console.log(`${r.table.padEnd(26)} ${String(r.read).padStart(6)} / ${r.inserted}`)
    console.log('\nVerified: every row key from the old database exists in the new one.')
  }
} catch (e) {
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
} finally {
  await old.end()
  await target.end()
}
