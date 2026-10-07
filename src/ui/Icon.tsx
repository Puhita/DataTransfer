import { useState, type CSSProperties, type ReactNode } from 'react'

const PATHS = {
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  unlock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></>,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />,
  shieldCheck: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 6.1A9.5 9.5 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4-.9" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>,
  warn: <><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18v.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  flame: <path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  logout: <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 8l4 4-4 4M20 12H9" />,
  mark: <><rect x="3" y="3" width="12" height="12" rx="3.5" /><rect x="9" y="9" width="12" height="12" rx="3.5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.3c2.2.6 3.5 2.5 3.5 5.7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon(props: { name: IconName; size?: 'sm' | 'lg' | 'xl'; className?: string; style?: CSSProperties }) {
  const cls = ['ic', props.size ? `ic-${props.size}` : '', props.className ?? ''].filter(Boolean).join(' ')
  return (
    <svg className={cls} style={props.style} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[props.name]}
    </svg>
  )
}

export function Brand(props: { light?: boolean }) {
  return (
    <div className="brand" style={props.light ? { color: 'var(--code-text)' } : undefined}>
      <Icon name="mark" size="lg" className="mark" style={props.light ? { color: 'var(--code-text)' } : undefined} />
      DataTransfer
    </div>
  )
}

export function Avatar(props: { name: string; small?: boolean }) {
  return <span className={'avatar' + (props.small ? ' avatar-sm' : '')}>{props.name.charAt(0).toUpperCase()}</span>
}

/** Password/passphrase input with a show/hide button. */
export function SecretInput(p: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  label: string
  invalid?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="inwrap">
      <input
        id={p.id}
        className={'input' + (p.invalid ? ' is-error' : '')}
        type={show ? 'text' : 'password'}
        required
        value={p.value}
        placeholder={p.placeholder}
        autoComplete={p.autoComplete}
        autoFocus={p.autoFocus}
        onChange={(e) => p.onChange(e.target.value)}
      />
      <button type="button" className="iconbtn" aria-label={(show ? 'Hide ' : 'Show ') + p.label} aria-pressed={show} onClick={() => setShow(!show)}>
        <Icon name={show ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  )
}

