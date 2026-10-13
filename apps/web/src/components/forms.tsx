import type { ReactNode, InputHTMLAttributes } from "react";
import { useId, useState } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
export function Field({
  label,
  hint,
  id: providedId,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        {...props}
        aria-describedby={
          [props["aria-describedby"], hint && hintId]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function PasswordField({
  label,
  hint,
  id: providedId,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <Input
          id={id}
          {...props}
          type={show ? "text" : "password"}
          aria-describedby={
            [props["aria-describedby"], hint && hintId]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={props.disabled}
          aria-label={`${show ? "Скрыть" : "Показать"} ${label.toLocaleLowerCase("ru")}`}
          aria-pressed={show}
          onClick={() => setShow(!show)}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
      </div>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function Submit({
  busy,
  disabled = false,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="submit"
      disabled={busy || disabled}
      aria-busy={busy}
      className="submit-button"
    >
      <LoaderCircle
        size={16}
        className={`submit-spinner ${busy ? "spin" : ""}`}
        aria-hidden
      />
      <span className="submit-label">{children}</span>
    </Button>
  );
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="error-message" role="alert">
      {error}
    </div>
  ) : null;
}
