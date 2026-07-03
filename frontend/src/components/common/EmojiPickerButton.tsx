import { useEffect, useRef, useState } from "react";

const EMOJI_OPTIONS = [
  "😀",
  "😁",
  "😂",
  "😊",
  "😍",
  "🙏",
  "👍",
  "❤️",
  "🔥",
  "🎉",
  "🤝",
  "✅",
  "📞",
  "💬",
  "🙌",
  "😔",
];

type EmojiPickerButtonProps = {
  onSelect: (emoji: string) => void;
};

export function EmojiPickerButton({ onSelect }: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div className="emoji-picker" ref={rootRef}>
      <button
        type="button"
        className="ghost-button emoji-picker-trigger"
        aria-label="Insert emoji"
        onClick={() => setOpen((current) => !current)}
      >
        🙂
      </button>
      {open ? (
        <div className="emoji-picker-panel">
          {EMOJI_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="emoji-picker-option"
              onClick={() => {
                onSelect(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
