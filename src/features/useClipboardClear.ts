import { useCallback, useEffect, useRef, useState } from 'react'

export const CLIPBOARD_CLEAR_S = 30

/** Copy text, then wipe the clipboard after a countdown (also if the component goes away first). */
export function useClipboardClear(seconds = CLIPBOARD_CLEAR_S) {
  const [left, setLeft] = useState(0) // seconds until the clipboard is cleared; 0 = nothing pending
  const timer = useRef<number>(0)
  const pending = useRef(false) // clipboard still holds our text

  useEffect(
    () => () => {
      window.clearInterval(timer.current)
      if (pending.current) navigator.clipboard.writeText('').catch(() => {})
    },
    [],
  )

  /** Rejects if the browser blocks clipboard access. */
  const copy = useCallback(
    async (text: string) => {
      await navigator.clipboard.writeText(text)
      window.clearInterval(timer.current)
      pending.current = true
      let s = seconds
      setLeft(s)
      timer.current = window.setInterval(() => {
        s -= 1
        setLeft(s)
        if (s <= 0) {
          window.clearInterval(timer.current)
          pending.current = false
          navigator.clipboard.writeText('').catch(() => {})
        }
      }, 1000)
    },
    [seconds],
  )

  return { left, copy }
}
