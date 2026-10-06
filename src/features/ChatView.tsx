import { useEffect, useState } from 'react'
import { safetyNumber } from '../crypto'
import { acceptPeerKeyChange, checkPeerKeyChange, type ChatInfo, type ProfileRow } from '../lib/api'
import { ChatRoom } from './ChatRoom'
import { SecretsRoom } from './SecretsRoom'

export function ChatView(props: { me: ProfileRow; chat: ChatInfo; onDelete: () => void }) {
  const { me, chat } = props
  const [tab, setTab] = useState<'chat' | 'secrets'>('chat')
  const [safety, setSafety] = useState<string | null>(null)
  const [showSafety, setShowSafety] = useState(false)
  const [keyState, setKeyState] = useState<'new' | 'same' | 'changed'>('same')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const s = await safetyNumber(
        { encPublic: me.enc_public_key, signPublic: me.sign_public_key },
        { encPublic: chat.peer.enc_public_key, signPublic: chat.peer.sign_public_key },
      )
      const k = await checkPeerKeyChange(chat.peer)
      if (alive) {
        setSafety(s)
        setKeyState(k)
      }
    })()
    return () => {
      alive = false
    }
  }, [me, chat.peer])

  return (
    <div className="chatview">
      <header>
        <b>@{chat.peer.username}</b>
        <button className="ghost small" onClick={() => setShowSafety(true)}>
          🛡 Verify
        </button>
        <span className="spacer" />
        <div className="tabs">
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
          <button className={tab === 'secrets' ? 'on' : ''} onClick={() => setTab('secrets')}>
            🔑 Secrets
          </button>
        </div>
      </header>

      {keyState === 'changed' && (
        <div className="warn">
          @{chat.peer.username}'s encryption keys changed since you first chatted. This can mean a new account, or someone
          tampering with the server. Verify the safety number with them before sharing secrets.
          <button
            onClick={async () => {
              await acceptPeerKeyChange(chat.peer)
              setKeyState('same')
            }}
          >
            I verified, trust new keys
          </button>
        </div>
      )}
      {keyState === 'new' && (
        <div className="info">
          Keys have not been verified yet. Compare the safety number with @{chat.peer.username} (tap Verify) over another channel.
        </div>
      )}

      {tab === 'chat' ? (
        <ChatRoom key={chat.chat.id} me={me} chat={chat} room={chat.chat} />
      ) : (
        <SecretsRoom key={chat.secrets.id} me={me} chat={chat} room={chat.secrets} />
      )}

      {showSafety && (
        <div className="modal" onClick={() => setShowSafety(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Safety number</h2>
            <p className="muted">Read this out to @{chat.peer.username} by phone or in person. If it matches on both sides, nobody is intercepting your keys.</p>
            <pre className="recovery">{safety ?? '…'}</pre>
            <div className="row">
              <button className="ghost danger" onClick={props.onDelete}>
                Delete chat for both
              </button>
              <span className="spacer" />
              <button onClick={() => setShowSafety(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
