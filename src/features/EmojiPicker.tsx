import { useState } from 'react'

const GROUPS: { icon: string; emojis: string[] }[] = [
  { icon: '😀', emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤔 🤨 😐 😑 😶 🙄 😏 😬 😴 🤤 😷 🤒 🤯 😎 🤓 🥳 😢 😭 😤 😡 🤬 😱 😨 🥺 😳 🫡 🫠'.split(' ') },
  { icon: '👍', emojis: '👍 👎 👌 ✌️ 🤞 🤝 🙏 👏 🙌 💪 👀 🧠 ✍️ 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 ✨ 🔥 💯 ✅ ❌ ⚠️ 🔒 🔑 🛡️ 🚀 🎉'.split(' ') },
  { icon: '🐶', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🦄 🐝 🦋 🐢 🐙 🌵 🌲 🌸 🌍 ☀️ 🌙 ⭐ ⚡ 🌈 ☕ 🍕 🍔 🍺'.split(' ') },
]

export function EmojiPicker(props: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(0)

  return (
    <div className="emoji">
      <button type="button" className="ghost" title="Emoji" aria-label="Emoji" onClick={() => setOpen(!open)}>
        😊
      </button>
      {open && (
        <div className="emojipop">
          <div className="emojitabs">
            {GROUPS.map((g, i) => (
              <button type="button" key={g.icon} className={i === group ? 'on' : ''} onClick={() => setGroup(i)}>
                {g.icon}
              </button>
            ))}
          </div>
          <div className="emojigrid">
            {GROUPS[group].emojis.map((e) => (
              <button type="button" key={e} onClick={() => props.onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
