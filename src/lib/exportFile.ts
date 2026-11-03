import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

const DIR = 'exports'

/** "Apollo / Staging" -> "Apollo-Staging.env" */
export const exportName = (title: string) => (title.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'secrets') + '.env'

/** The file is plain text: anyone who gets it can read the secrets. */
export async function exportTextFile(filename: string, text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    // A WebView cannot download a blob, so write to the app's private cache and open the share sheet (Save to Files, Drive, ...).
    await cleanupExports()
    const { uri } = await Filesystem.writeFile({ path: `${DIR}/${filename}`, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
    await Share.share({ title: filename, dialogTitle: 'Save or share', url: uri })
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Removes exported files from the app cache. Called on lock and log out so plaintext does not linger. */
export async function cleanupExports(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await Filesystem.rmdir({ path: DIR, directory: Directory.Cache, recursive: true })
  } catch {
    /* nothing exported yet */
  }
}
