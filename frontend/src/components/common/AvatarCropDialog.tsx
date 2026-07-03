import { useEffect, useState } from "react";

const CROP_STAGE_SIZE = 280;
const OUTPUT_SIZE = 320;

type AvatarCropDialogProps = {
  open: boolean;
  imageSrc: string | null;
  saving?: boolean;
  onCancel: () => void;
  onSave: (dataUrl: string) => void;
};

export function AvatarCropDialog({
  open,
  imageSrc,
  saving = false,
  onCancel,
  onSave,
}: AvatarCropDialogProps) {
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  useEffect(() => {
    if (!open) return;
    setScale(1);
    setOffsetX(0);
    setOffsetY(0);
  }, [imageSrc, open]);

  if (!open || !imageSrc) return null;

  const handleSave = async () => {
    const image = await loadImage(imageSrc);
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    context.save();
    context.beginPath();
    context.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
    context.closePath();
    context.clip();

    const baseScale = Math.max(OUTPUT_SIZE / image.width, OUTPUT_SIZE / image.height);
    const drawWidth = image.width * baseScale * scale;
    const drawHeight = image.height * baseScale * scale;
    const drawX = (OUTPUT_SIZE - drawWidth) / 2 + (offsetX / CROP_STAGE_SIZE) * OUTPUT_SIZE;
    const drawY = (OUTPUT_SIZE - drawHeight) / 2 + (offsetY / CROP_STAGE_SIZE) * OUTPUT_SIZE;
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    context.restore();

    onSave(canvas.toDataURL("image/png"));
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="dialog-card avatar-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Crop profile image"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h3>Crop profile image</h3>
            <p className="muted-copy">Adjust the image inside the circle, then save it.</p>
          </div>
          <button type="button" className="ghost-button compact-button" onClick={onCancel}>
            Close
          </button>
        </div>

        <div className="avatar-crop-stage">
          <img
            src={imageSrc}
            alt="Profile crop preview"
            style={{
              transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${scale})`,
            }}
          />
          <div className="avatar-crop-mask" aria-hidden="true" />
        </div>

        <div className="avatar-crop-controls">
          <label>
            <span>Zoom</span>
            <input
              type="range"
              min="1"
              max="2.4"
              step="0.05"
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Horizontal</span>
            <input
              type="range"
              min="-120"
              max="120"
              step="1"
              value={offsetX}
              onChange={(event) => setOffsetX(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Vertical</span>
            <input
              type="range"
              min="-120"
              max="120"
              step="1"
              value={offsetY}
              onChange={(event) => setOffsetY(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="dialog-actions">
          <button type="button" className="ghost-button compact-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save image"}
          </button>
        </div>
      </div>
    </div>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load image."));
    image.src = src;
  });
}
