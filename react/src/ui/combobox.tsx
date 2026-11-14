import { Combobox as Primitive } from "@base-ui/react/combobox";
import { useMemo, useState, type ReactNode } from "react";
import { mergeClassName, type StateClassName } from "./class-name.ts";
import { ChevronGlyph, CloseGlyph } from "./glyphs.tsx";

// The parts, for a combobox this wrapper's shape cannot express — multi-select with chips,
// groups, a virtualised list.
export const ComboboxRoot = Primitive.Root;
export const ComboboxInput = Primitive.Input;
export const ComboboxInputGroup = Primitive.InputGroup;
export const ComboboxTrigger = Primitive.Trigger;
export const ComboboxClear = Primitive.Clear;
export const ComboboxPortal = Primitive.Portal;
export const ComboboxPositioner = Primitive.Positioner;
export const ComboboxPopup = Primitive.Popup;
export const ComboboxList = Primitive.List;
export const ComboboxItem = Primitive.Item;
export const ComboboxEmpty = Primitive.Empty;
export const ComboboxGroup = Primitive.Group;
export const ComboboxGroupLabel = Primitive.GroupLabel;

/**
 * What the input shows: the QUERY while the list is open, the selected item's LABEL while it
 * is closed.
 *
 * The two are different strings and swapping them is the whole job. Show the label while
 * typing and every keystroke is overwritten by the old selection; show the query while
 * closed and the field goes blank the moment focus leaves, even though a value is set.
 */
export function comboboxInputValue<T>(
  open: boolean,
  query: string,
  value: T | null,
  getLabel: (item: T) => string,
): string {
  if (open) return query;
  return value === null ? "" : getLabel(value);
}

/** Pass text for the loading state. There is no default text or English fallback. */
type ComboboxLoadingState =
  | { loading: boolean; loadingHint: ReactNode }
  | { loading?: undefined; loadingHint?: undefined };

export type ComboboxProps<T> = Omit<
  Primitive.Root.Props<T, false, T>,
  | "children"
  | "items"
  | "filteredItems"
  | "filter"
  | "value"
  | "defaultValue"
  | "multiple"
  | "open"
  | "defaultOpen"
  | "inputValue"
  | "defaultInputValue"
  | "onInputValueChange"
  | "itemToStringLabel"
  | "isItemEqualToValue"
> & {
  value: T | null;
  /**
   * Items for the current query. Filtering is yours: this passes `filter={null}` to Base UI, so the
   * list shows exactly what you return, whether it is a server search, a fuzzy match or a bounded
   * page. Bound it here if it needs bounding; there is no cap in the wrapper, because a cap would
   * quietly truncate a list a caller meant to show whole.
   */
  search: (query: string) => readonly T[];
  /** Stable identity of an item: its React key, and how two items are compared. */
  getKey: (item: T) => string;
  /** The item's text, shown in the input once it is picked and used for typeahead matches. */
  getLabel: (item: T) => string;
  renderItem?: (item: T) => ReactNode;
  /**
   * Shown when the query matches nothing. Required: "no results" with no next step is a dead
   * end, and this is the line that offers one.
   */
  emptyHint: ReactNode;
  /** Label for the clear button. Required because the button has an icon and no text. */
  clearLabel: string;
  /** Label for the button that opens the list. Required, same reason. */
  openLabel: string;
  /** Accessible name for the input, when no visible label points at it. */
  label?: string;
  leadingIcon?: ReactNode;
  /** Classes for the input itself. */
  className?: StateClassName<Primitive.Input.State>;
  popupClassName?: StateClassName<Primitive.Popup.State>;
  inputProps?: Primitive.Input.Props;
  /**
   * Positioner props: `align`, `side`, `sideOffset`, `collisionPadding` and the stacking order. The
   * default `z-[60]` puts the list above the overlay layer (z-50: dialog, drawer); raise it with
   * `positionerProps={{ className: "z-[80]" }}` if the app stacks something higher than a dialog
   * above it.
   */
  positionerProps?: Primitive.Positioner.Props;
} & ComboboxLoadingState;

/**
 * A text field that filters a list. `name`, `form`, `required`, `id` and `disabled` pass
 * straight through to the root, so it submits inside a `<form>`.
 *
 * Controlled only: the wrapper owns `open` and the input value, because those two are what
 * the label/query bridge is made of.
 */
export function Combobox<T>({
  value,
  search,
  getKey,
  getLabel,
  renderItem,
  emptyHint,
  loading,
  loadingHint,
  clearLabel,
  openLabel,
  label,
  leadingIcon,
  className,
  popupClassName,
  inputProps,
  positionerProps,
  onOpenChange,
  ...rest
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const items = useMemo(() => search(query), [query, search]);

  return (
    <Primitive.Root<T, false, T>
      value={value}
      items={items}
      open={open}
      itemToStringLabel={getLabel}
      isItemEqualToValue={(left, right) => getKey(left) === getKey(right)}
      // `null` hands filtering to `search`. Base UI's own filter would run a SECOND pass over
      // an already-filtered list, so a server that matched on something the label does not
      // contain — an id, a phone number, an accent-stripped name — would return rows the
      // client then threw away.
      filter={null}
      inputValue={comboboxInputValue(open, query, value, getLabel)}
      onInputValueChange={(next) => {
        setQuery(next);
        if (!open) setOpen(true);
      }}
      onOpenChange={(next, details) => {
        setOpen(next);
        // A fresh open starts from the whole list, not from whatever was typed last time.
        if (next) setQuery("");
        onOpenChange?.(next, details);
      }}
      {...rest}
    >
      <Primitive.InputGroup className="relative">
        {leadingIcon ? (
          <span className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-muted-foreground">
            {leadingIcon}
          </span>
        ) : null}
        <Primitive.Input
          aria-label={label}
          autoComplete="off"
          {...inputProps}
          className={mergeClassName(
            [
              // No focus style: the field keeps the app's one `:focus-visible` outline. Swapping
              // it for a `ring-*` loses forced-colors mode, where a box-shadow is forced to none.
              "w-full min-w-0 rounded-md border border-input bg-background py-2 pr-16 pl-3 text-base text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 md:text-sm",
              leadingIcon && "pl-9",
            ],
            // The caller's classes land BEFORE the space reserved for the buttons is
            // re-applied below, so a `px-*` of their own cannot swallow it.
            className,
          )}
        />
        <span className="absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 items-center gap-0.5">
          {/* Base UI unmounts Clear on its own when there is nothing to clear, so this is not
              wrapped in a `value &&`. The input keeps its right padding either way, so the
              text does not reflow when a value appears. */}
          <Primitive.Clear
            aria-label={clearLabel}
            className="inline-flex rounded-full p-1.5 text-muted-foreground"
          >
            <CloseGlyph />
          </Primitive.Clear>
          <Primitive.Trigger
            aria-label={openLabel}
            className="inline-flex rounded-full p-1.5 text-muted-foreground"
          >
            <ChevronGlyph />
          </Primitive.Trigger>
        </span>
      </Primitive.InputGroup>
      <Primitive.Portal>
        {/* Above the overlay layer (z-50: dialog, drawer). The list portals to the body and
            so does the dialog it may be sitting in, so nesting decides nothing and z decides
            everything — one step lower and the list paints behind its own anchor. */}
        <Primitive.Positioner
          sideOffset={4}
          {...positionerProps}
          className={mergeClassName(
            "z-[60] max-w-[var(--available-width)] outline-none",
            positionerProps?.className,
          )}
        >
          <Primitive.Popup
            className={mergeClassName(
              "w-[var(--anchor-width)] overflow-hidden border border-border bg-popover text-popover-foreground outline-none transition-[scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
              popupClassName,
            )}
          >
            {/* Empty stays MOUNTED and swaps its children — it is the popup's live region,
                and a live region a screen reader was never given cannot announce a change to
                it. So it is not wrapped in a condition, and its padding sits on the child
                instead: the part's own div is left in the DOM at zero height when there is
                something in the list, rather than as a blank 40px strip above it. */}
            <Primitive.Empty>
              <div className="px-3 py-2 text-muted-foreground">
                {loading ? loadingHint : emptyHint}
              </div>
            </Primitive.Empty>
            {/* `--available-height` is the room the positioner measured between the anchor
                and the edge of the viewport. Without it the list is unbounded and a long
                result set runs off the bottom of the screen with no way to reach the end.
                Focus stays in the input and the highlight follows the arrow keys, so an item
                never matches `:focus-visible`. Forced colors paint no background, which takes
                the highlight with it, so there the highlighted item draws an outline, inset
                or the list's overflow clips it at both edges. */}
            <Primitive.List className="max-h-[var(--available-height)] overflow-y-auto">
              {(item: T) => (
                <Primitive.Item
                  key={getKey(item)}
                  value={item}
                  className="cursor-default px-3 py-2 data-highlighted:bg-accent data-highlighted:text-accent-foreground forced-colors:data-highlighted:outline-2 forced-colors:data-highlighted:-outline-offset-2"
                >
                  {renderItem ? renderItem(item) : getLabel(item)}
                </Primitive.Item>
              )}
            </Primitive.List>
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
