import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.datatransfer.app',
  appName: 'DataTransfer',
  webDir: 'dist',
  android: { allowMixedContent: false },
}

export default config
