import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Disable selection while keeping the option visible. */
  disabled?: boolean;
}

export interface DropdownProps<V extends string = string> {
  value: V;
  options: ReadonlyArray<DropdownOption<V>>;
  onChange: (next: V) => void;
  /** Accessible label, used for aria-label when no visible label exists. */
  ariaLabel?: string;
  /** Optional id (auto-generated otherwise) — useful for <label htmlFor=…>. */
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Minimum panel width (px). Defaults to the trigger's width. */
  minPanelWidth?: number;
}

/**
 * Themed replacement for the native HTML `<select>`. We render our own popup because the OS-drawn
 * dropdown that browsers use for native `<select>` ignores CSS background/colour rules on Windows
 * and Chromium, which made our dark theme bleed white. This component is fully styleable and
 * keyboard-navigable (Arrow keys, Home/End, Enter/Space, Escape).
 */
export function Dropdown<V extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  placeholder,
  disabled,
  className,
  minPanelWidth
}: DropdownProps<V>) {
  const generatedId = useId();
  const fieldId = id ?? `dropdown-${generatedId}`;
  const listboxId = `${fieldId}-listbox`;

  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() => {
    const initial = options.findIndex((option) => option.value === value);
    return initial >= 0 ? initial : 0;
  });

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLUListElement | null>(null);

  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger after closing so keyboard users don't lose context.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    const initial = selectedIndex >= 0 ? selectedIndex : 0;
    setHighlight(initial);
    setOpen(true);
  }, [disabled, selectedIndex]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close();
    },
    [close, onChange, options]
  );

  // Close on outside pointer events.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    return () => document.removeEventListener("pointerdown", handlePointer);
  }, [open]);

  // Scroll the highlighted option into view while navigating with the keyboard.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const item = panel.children[highlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const handleTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPanel();
    }
  };

  const handlePanelKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => {
        for (let i = 1; i <= options.length; i += 1) {
          const next = (current + i) % options.length;
          if (!options[next].disabled) return next;
        }
        return current;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => {
        for (let i = 1; i <= options.length; i += 1) {
          const next = (current - i + options.length) % options.length;
          if (!options[next].disabled) return next;
        }
        return current;
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const first = options.findIndex((option) => !option.disabled);
      if (first >= 0) setHighlight(first);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      for (let i = options.length - 1; i >= 0; i -= 1) {
        if (!options[i].disabled) {
          setHighlight(i);
          break;
        }
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(highlight);
      return;
    }
    if (event.key === "Tab") {
      // Allow Tab to close cleanly without trapping focus.
      setOpen(false);
    }
  };

  const triggerLabel = selected ? selected.label : placeholder ?? "Select...";

  return (
    <div
      ref={wrapperRef}
      className={`dropdown${open ? " open" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={fieldId}
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={handleTriggerKey}
      >
        <span className="dropdown-value">{triggerLabel}</span>
        <ChevronDown size={14} className="dropdown-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={(node) => {
            panelRef.current = node;
            // Capture focus the moment the panel mounts so keyboard navigation just works.
            node?.focus();
          }}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${fieldId}-option-${highlight}`}
          className="dropdown-panel"
          style={minPanelWidth !== undefined ? { minWidth: minPanelWidth } : undefined}
          onKeyDown={handlePanelKey}
        >
          {options.map((option, index) => {
            const isSelected = index === selectedIndex;
            const isHighlighted = index === highlight;
            const optionClass =
              "dropdown-option" +
              (isSelected ? " selected" : "") +
              (isHighlighted ? " highlighted" : "") +
              (option.disabled ? " disabled" : "");
            return (
              <li
                key={String(option.value)}
                id={`${fieldId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={optionClass}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  // Use mousedown so the click commits before the panel's blur fires.
                  event.preventDefault();
                  commit(index);
                }}
              >
                <span className="dropdown-option-label">{option.label}</span>
                {isSelected && <Check size={14} className="dropdown-option-check" aria-hidden="true" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
