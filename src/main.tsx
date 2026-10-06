import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/source-sans-3'
import '@fontsource-variable/jetbrains-mono'
import { App } from './App'
import './styles.css'

// Follow the OS colour scheme; the design system themes via [data-theme].
const mq = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => {
  document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'
}
applyTheme()
mq.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
