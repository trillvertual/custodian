import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ImageUp } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ErrorMessage } from "./forms";
import { parseTotpQr, readQrImage } from "../lib/qr-totp";
import type { VaultStore } from "../lib/store";
export function TotpQr({
  open,
  onClose,
  onUse,
  store,
}: {
  open: boolean;
  onClose: () => void;
  onUse: (uri: string, issuer: string) => void;
  store: VaultStore;
}) {
  const [candidate, setCandidate] = useState<ReturnType<
      typeof parseTotpQr
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    controls = useRef<{ stop: () => void } | null>(null),
    generation = useRef(0),
    mounted = useRef(false),
    running = useRef(false);
  const view = useMemo(
      () => ({ open, keys: store.keys.current }),
      [open, store.keys.current],
    ),
    current = useRef(view);
  current.current = view;
  function valid(snapshot: typeof view, attempt: number) {
    return (
      mounted.current &&
      snapshot.open &&
      current.current === snapshot &&
      snapshot.keys !== null &&
      store.keys.current === snapshot.keys &&
      generation.current === attempt
    );
  }
  function stop() {
    generation.current++;
    running.current = false;
    controls.current?.stop();
    controls.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  useEffect(() => {
    if (!open) {
      stop();
      setCamera(false);
      setBusy(false);
      setCandidate(null);
      setError("");
    }
  }, [open]);
  async function scan(file: Blob) {
    if (running.current) return;
    stop();
    setCamera(false);
    running.current = true;
    setBusy(true);
    setError("");
    setCandidate(null);
    const snapshot = view,
      attempt = ++generation.current;
    try {
      const raw = await readQrImage(file);
      if (valid(snapshot, attempt)) setCandidate(parseTotpQr(raw));
    } catch (error) {
      if (valid(snapshot, attempt))
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось прочитать QR-код.",
        );
    } finally {
      if (valid(snapshot, attempt)) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!open) return;
    const paste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((file) =>
        file.type.startsWith("image/"),
      );
      if (file) {
        event.preventDefault();
        void scan(file);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [open, view]);
  useEffect(() => {
    if (!open || !camera) return;
    const hide = () => {
      if (document.hidden) {
        stop();
        setCamera(false);
        setBusy(false);
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [open, camera]);
  async function startCamera() {
    if (running.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "Для камеры откройте Custodian по HTTPS. Также можно загрузить изображение.",
      );
      return;
    }
    stop();
    running.current = true;
    setBusy(true);
    setCamera(true);
    setCandidate(null);
    setError("");
    const snapshot = view,
      attempt = ++generation.current;
    let capture: MediaStream | null = null;
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (!valid(snapshot, attempt)) return;
      capture = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!valid(snapshot, attempt)) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const control = await new BrowserQRCodeReader().decodeFromStream(
        capture,
        video.current!,
        (result, _, control) => {
          if (!result || !valid(snapshot, attempt)) return;
          try {
            const value = parseTotpQr(result.getText());
            control.stop();
            stop();
            setCandidate(value);
            setCamera(false);
            setBusy(false);
          } catch {
            setError(
              "В кадре QR другого типа. Наведите камеру на код настройки 2FA.",
            );
          }
        },
      );
      if (!valid(snapshot, attempt)) control.stop();
      else {
        controls.current = control;
        setBusy(false);
      }
    } catch {
      capture?.getTracks().forEach((track) => track.stop());
      if (valid(snapshot, attempt)) {
        stop();
        setCamera(false);
        setBusy(false);
        setError(
          "Не удалось открыть камеру. Проверьте разрешение браузера или загрузите изображение.",
        );
      }
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Добавить 2FA через QR"
      description="Распознавание выполняется на этом устройстве. Изображение не отправляется на сервер."
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Изображение с QR-кодом"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void scan(file);
        }}
      />
      {!candidate && (
        <>
          <Button
            variant="outline"
            disabled={busy || camera}
            onClick={() => input.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) void scan(file);
            }}
          >
            <ImageUp size={16} />
            Выбрать или перетащить изображение
          </Button>
          <p className="muted">
            Можно вставить скриншот через Ctrl/⌘+V. PNG, JPEG или WebP, до 10
            МБ.
          </p>
        </>
      )}
      <video
        ref={video}
        className={camera ? "qr-camera" : "hidden"}
        autoPlay
        muted
        playsInline
        aria-label="Камера для QR-кода"
      />
      {camera ? (
        <Button
          variant="outline"
          onClick={() => {
            stop();
            setCamera(false);
            setBusy(false);
          }}
        >
          Остановить камеру
        </Button>
      ) : (
        !candidate && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void startCamera()}
          >
            <Camera size={16} />
            Использовать камеру
          </Button>
        )
      )}
      {busy && !camera && (
        <p role="status" className="muted">
          Распознавание QR…
        </p>
      )}
      {candidate && (
        <div className="qr-confirm">
          <strong>{candidate.issuer || "Настройки 2FA"}</strong>
          {candidate.account && <p>{candidate.account}</p>}
          <p className="muted">
            {candidate.config.digits} цифр · {candidate.config.period} секунд ·{" "}
            {candidate.config.algorithm}
          </p>
          <p>Секрет будет добавлен после подтверждения.</p>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setCandidate(null)}>
              Другой QR
            </Button>
            <Button
              onClick={() => {
                if (store.keys.current === view.keys && view.keys) {
                  onUse(candidate.uri, candidate.issuer);
                  onClose();
                }
              }}
            >
              Использовать 2FA
            </Button>
          </div>
        </div>
      )}
      <ErrorMessage error={error} />
    </Dialog>
  );
}
