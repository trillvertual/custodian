import { useEffect, useState, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./ui/button";

export function NavigationDrawer({
  children,
  open,
  onOpenChange,
  trigger,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) onOpenChange(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [onOpenChange]);
  if (!mobile)
    return (
      <aside className="sidebar" id="vault-navigation">
        {children}
      </aside>
    );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="nav-scrim" />
        <DialogPrimitive.Content
          asChild
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <aside className="sidebar sidebar-open" id="vault-navigation">
            <DialogPrimitive.Title className="sr-only">
              Навигация хранилища
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Записи, папки и управление командой.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <Button
                className="sidebar-close"
                variant="ghost"
                size="icon"
                aria-label="Закрыть навигацию"
              >
                <X size={17} />
              </Button>
            </DialogPrimitive.Close>
            {children}
          </aside>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
