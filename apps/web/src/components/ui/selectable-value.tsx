/** Read-only output, deliberately outside password managers' input collection. */
export function SelectableValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  function select(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return (
    <div
      role="textbox"
      aria-label={label}
      aria-readonly="true"
      tabIndex={0}
      className="selectable-value"
      onFocus={(event) => select(event.currentTarget)}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          select(event.currentTarget);
        }
      }}
    >
      {value}
    </div>
  );
}
