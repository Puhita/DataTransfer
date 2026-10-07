import { useCallback, useEffect, useMemo, useState } from 'react'
import { safetyNumber } from '../crypto'
import { checkPeerKeyChange, isPeerVerified, markPeerVerified, type ChatInfo, type ProfileRow } from '../lib/api'
import { Avatar, Icon } from '../ui/Icon'
import { ChatRoom } from './ChatRoom'
import { SecretsRoom } from './SecretsRoom'

type KeyState = 'unverified' | 'verified' | 'changed'

export function ChatView(props: { me: ProfileRow; chat: ChatInfo; onBack: () => void; onDelete: () => void }) {
  const { me, chat } = props
  const [tab, setTab] = useState<'chat' | 'secrets'>('chat')
  const [safety, setSafety] = useState<string | null>(null)
  const [showVerify, setShowVerify] = useState(false)
  const [keyState, setKeyState] = useState<KeyState>('unverified')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refreshKeys = useCallback(async () => {
    const change = await checkPeerKeyChange(chat.peer)
    if (change === 'changed') return setKeyState('changed')
    setKeyState((await isPeerVerified(chat.peer)) ? 'verified' : 'unverified')
  }, [chat.peer])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const s = await safetyNumber(
        { encPublic: me.enc_public_key, signPublic: me.sign_public_key },
        { encPublic: chat.peer.enc_public_key, signPublic: chat.peer.sign_public_key },
      )
      if (alive) setSafety(s)
      await refreshKeys()
    })()
    return () => {
      alive = false
    }
  }, [me, chat.peer, refreshKeys])

  const trust = async () => {
    await markPeerVerified(chat.peer)
    setKeyState('verified')
  }

  const name = chat.peer.username
  const members = useMemo(() => [chat.peer], [chat.peer])
  const secrets = tab === 'secrets'

  return (
    <main className={'pane' + (secrets ? ' vault' : '')} data-space={secrets ? 'secrets' : undefined}>
      <header className="pane-head">
        <div className="top">
          <button className="iconbtn only-m" aria-label="Back to chats" onClick={props.onBack}>
            <Icon name="back" />
          </button>
          <Avatar name={name} small={false} />
          <div className="nm">
            <h1 className="t-h3" style={{ margin: 0 }}>@{name}</h1>
            <div className={'msub only-m' + (keyState === 'changed' ? ' warn' : '')}>
              <Icon name={keyState === 'changed' ? 'warn' : 'lock'} size="sm" style={{ color: keyState === 'changed' ? undefined : 'var(--accent)' }} />
              {keyState === 'changed' ? 'Encrypted · keys changed' : keyState === 'verified' ? 'Encrypted · keys verified' : 'Encrypted · keys not verified'}
            </div>
          </div>
          <span className="pill only-d"><Icon name="lock" size="sm" />End-to-end encrypted</span>
          {keyState === 'verified' && <span className="pill only-d"><Icon name="shieldCheck" size="sm" />Keys verified</span>}
          {keyState === 'unverified' && <span className="pill only-d"><Icon name="shield" size="sm" />Not verified</span>}
          {keyState === 'changed' && <span className="pill pill-warn only-d"><Icon name="warn" size="sm" />Keys changed</span>}
          <button className="btn btn-secondary btn-sm only-d" onClick={() => setShowVerify(true)}>Verify keys</button>
          <button className="iconbtn bordered only-m" aria-label="Verify keys" onClick={() => setShowVerify(true)}>
            <Icon name="shieldCheck" />
          </button>
        </div>
        <div className="tabbar" role="tablist">
          <button className="tab" role="tab" aria-selected={!secrets} onClick={() => setTab('chat')}>Chat</button>
          <button className="tab" role="tab" aria-selected={secrets} onClick={() => setTab('secrets')}>
            <Icon name="key" />
            Secrets
          </button>
        </div>
      </header>

      {keyState === 'changed' && (
        <div style={{ padding: '16px 24px 0' }} className="banner-wrap">
          <div className="banner banner-warn" role="alert">
            <Icon name="warn" size="lg" />
            <div className="body">
              <b>Keys changed.</b> @{name}'s encryption keys are different from before. Check the safety number with them before you trust the new keys.
            </div>
            <button className="btn btn-primary btn-sm" onClick={trust}>I verified, trust new keys</button>
          </div>
        </div>
      )}
      {keyState === 'unverified' && (
        <div style={{ padding: '16px 24px 0' }} className="banner-wrap">
          <div className="banner banner-info">
            <Icon name="info" size="lg" />
            <div className="body">
              <b>Keys not verified yet.</b> Compare the safety number with @{name} to be sure only you two can read this chat.
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowVerify(true)}>Verify</button>
          </div>
        </div>
      )}

      {secrets ? (
        <SecretsRoom key={chat.secrets.id} me={me} members={members} room={chat.secrets} title={"@" + name} />
      ) : (
        <ChatRoom key={chat.chat.id} me={me} members={members} room={chat.chat} title={"@" + name} />
      )}

      {showVerify && (
        <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setShowVerify(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="vt" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="stack" style={{ gap: 6 }}>
                <h2 id="vt" className="t-h2" style={{ margin: 0 }}>Verify keys with @{name}</h2>
                <p className="t-body muted" style={{ margin: 0 }}>
                  Compare this number with @{name} on a call or in person. If all six groups match, only the two of you can read this chat.
                </p>
              </div>
              <button className="iconbtn" aria-label="Close" onClick={() => setShowVerify(false)}><Icon name="close" /></button>
            </div>

            <div className="stack" style={{ gap: 10 }}>
              <span className="t-label">Safety number</span>
              <div className="safety" role="group" aria-label="Safety number, six groups of five digits">
                {(safety ?? '').split(' ').filter(Boolean).map((g, i) => <div className="sgrp" key={i}>{g}</div>)}
              </div>
              {keyState === 'verified' ? (
                <div className="notice ok" role="status"><Icon name="shieldCheck" size="sm" />You marked these keys as verified.</div>
              ) : (
                <button className="btn btn-primary" onClick={trust} disabled={!safety}>
                  <Icon name="shieldCheck" />
                  The numbers match, mark as verified
                </button>
              )}
            </div>

            <div className="danger">
              <div className="stack" style={{ gap: 4 }}>
                <h3 className="t-body" style={{ margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="trash" style={{ color: 'var(--err)' }} />
                  Delete chat for both
                </h3>
                <p className="t-small" style={{ margin: 0 }}>
                  Removes this chat and everything in its Secrets room from both accounts. This can't be undone.
                </p>
              </div>
              <div className="cluster">
                {confirmDelete ? (
                  <>
                    <button className="btn btn-danger" onClick={props.onDelete}>Yes, delete it</button>
                    <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Keep chat</button>
                  </>
                ) : (
                  <button className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
                    <Icon name="trash" />
                    Delete chat for both
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
