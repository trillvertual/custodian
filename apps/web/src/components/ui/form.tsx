import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
} from "react";

const ValidationContext = createContext<{
  fieldId: string;
  messageId: string;
} | null>(null);
export function useFieldValidation(id: string) {
  const error = useContext(ValidationContext);
  return error?.fieldId === id ? error.messageId : undefined;
}

/** Keep HTML constraints, render errors ourselves instead of browser bubbles. */
export function Form({
  children,
  onSubmit,
  onChange,
  ...props
}: ComponentProps<"form">) {
  const messageId = useId();
  const [error, setError] = useState<{
    fieldId: string;
    message: string;
  } | null>(null);
  return (
    <ValidationContext.Provider
      value={error ? { fieldId: error.fieldId, messageId } : null}
    >
      <form
        {...props}
        noValidate
        onInvalid={(event) => event.preventDefault()}
        onChange={(event) => {
          setError(null);
          onChange?.(event);
        }}
        onSubmit={(event) => {
          if (!event.currentTarget.checkValidity()) {
            event.preventDefault();
            const field = event.currentTarget.querySelector<
              HTMLInputElement | HTMLTextAreaElement
            >("input:invalid, textarea:invalid");
            if (field) {
              const label =
                field.labels?.[0]?.textContent?.trim() ||
                field.getAttribute("aria-label") ||
                "поле";
              const validity = field.validity;
              const message = validity.valueMissing
                ? `Заполните поле «${label}».`
                : validity.tooShort
                  ? `В поле «${label}» нужно не менее ${field.minLength} символов.`
                  : validity.typeMismatch
                    ? `Проверьте формат поля «${label}».`
                    : `Проверьте значение поля «${label}».`;
              setError({ fieldId: field.id, message });
              field.focus();
            }
            return;
          }
          setError(null);
          onSubmit?.(event);
        }}
      >
        {error && (
          <div id={messageId} className="error-message" role="alert">
            {error.message}
          </div>
        )}
        {children}
      </form>
    </ValidationContext.Provider>
  );
}
