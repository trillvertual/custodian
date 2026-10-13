import {
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconTicket,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/api";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const RWP_URL = "https://rwp.rw/";
const PROMO_CODE = "LAZYBAGEL";

// The discount chip: brand copy, the same in every language.
const DISCOUNT = "-10%";

/**
 * Adapted from mishkatik/infra-billing RwpPromo.tsx with Custodian’s promo code.
 * A quiet dashed "tear-off" row; the popover carries the details and the promo code.
 */
export function RwpPromo({ side = "right" }: { side?: "right" | "top" }) {
  const [copied, setCopied] = useState(false);
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await copyToClipboard(PROMO_CODE);
      setCopied(true);
    } catch {
      toast.error(
        "Не удалось скопировать. Выделите промокод и скопируйте его вручную.",
      );
    }
  };

  return (
    <Popover onOpenChange={() => setCopied(false)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="RWP Shop -10%"
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-dashed border-border px-3.5 text-left text-[13px] outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <IconTicket
            aria-hidden
            stroke={1.5}
            className="size-[15px] shrink-0 text-ink-3"
          />
          <span className="flex-1 truncate">RWP Shop</span>
          <span className="text-xs text-ink-2">{DISCOUNT}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side={mobile ? "top" : side}
        align={mobile ? "start" : "end"}
        collisionPadding={16}
        aria-label="Скидка 10% на RWP Shop"
        className="w-80 max-w-[calc(100vw-32px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0"
      >
        <div className="flex items-center gap-3 border-b border-hairline p-4">
          {/* The RWP mark is drawn for a dark backdrop, so it always sits on an ink tile. */}
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#141310]">
            <img src="/rwp-logo.svg" alt="RWP" className="size-7 grayscale" />
          </div>
          <div className="flex items-center gap-2 text-[15px] font-medium">
            RWP Shop
            <span className="text-xs font-normal text-ink-2">{DISCOUNT}</span>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <p className="text-[13px] text-ink-2">
            Бот для VPN-коммерции на Remnawave: платежи, подписки, личный
            кабинет клиента и аналитика. Работает в браузере и как Mini App в
            Telegram.
          </p>

          <button
            type="button"
            onClick={copy}
            aria-label={
              copied ? "Промокод скопирован!" : "Скопировать промокод"
            }
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left transition-colors hover:bg-background"
          >
            <span className="text-xs text-ink-2">
              {copied ? "Промокод скопирован!" : "Скидка 10% по промокоду"}
            </span>
            <span className="flex items-center gap-1.5 font-mono text-sm">
              {PROMO_CODE}
              {copied ? (
                <IconCheck className="size-3.5" />
              ) : (
                <IconCopy className="size-3.5 text-ink-3" />
              )}
            </span>
          </button>

          <Button asChild size="sm" className="w-full">
            <a href={RWP_URL} target="_blank" rel="noopener noreferrer">
              Открыть rwp.rw
              <IconArrowUpRight className="size-4" />
            </a>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
