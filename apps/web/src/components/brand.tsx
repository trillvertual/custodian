import { cn } from "../lib/utils";

/** Vector rendition of the approved custodian-logo.png, also used by favicon.svg. */
export function BrandMark({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 1280 1280"
      className={cn("brand-mark", className)}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Custodian"}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <path
        className="brand-shell"
        d="M606 96Q650 70 695 96L1068 312Q1090 325 1090 350V451Q1090 476 1065 476H861Q851 476 842 470L680 365Q654 348 629 363L451 467Q428 480 428 507V749Q428 777 452 791L628 893Q653 908 679 891L842 784Q851 778 862 778H1065Q1090 778 1090 803V898Q1090 923 1068 936L696 1152Q650 1178 605 1152L221 930Q165 898 165 833V414Q165 350 221 318Z"
      />
      <path
        className="brand-core"
        d="M625 458Q652 443 678 458L787 521Q815 537 815 569V688Q815 719 788 735L678 799Q652 814 625 799L521 739Q493 723 493 691V567Q493 535 521 519Z"
      />
    </svg>
  );
}

export function Brand({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("brand custodian-brand", className)}>
      <BrandMark decorative />
      <span className={compact ? "sr-only" : "brand-wordmark"}>Custodian</span>
    </span>
  );
}
