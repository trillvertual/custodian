import type { ReactNode } from "react";
import { useDialogExit } from "../../lib/use-dialog-exit";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "./dialog-primitives";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  onExitComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  onExitComplete?: () => void;
}) {
  const exit = useDialogExit(open, onExitComplete);
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`dialog-content ${wide ? "dialog-wide" : ""}`}
        {...exit}
      >
        <DialogHeader className="dialog-heading">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? "" : "sr-only"}>
            {description || title}
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-inner">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}
