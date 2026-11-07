export function selectControl(id: string, options?: HTMLOptionElement[]) {
  const select = document.getElementById(id) as HTMLSelectElement;
  if (options) select.replaceChildren(...options);

  const label = select.labels?.[0]?.cloneNode(true) as HTMLLabelElement | undefined;
  label?.querySelector("select")?.remove();
  const name = select.getAttribute("aria-label") ?? label?.textContent?.trim() ?? "";
  const control = document.createElement("span");
  control.className = "select-control";
  const trigger = document.createElement("button");
  trigger.id = id;
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", name);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const valueLabel = document.createElement("span");
  valueLabel.className = "select-value";
  trigger.append(valueLabel);

  const list = document.createElement("div");
  list.id = `${id}-options`;
  list.className = "select-options";
  list.setAttribute("popover", "manual");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", name);
  trigger.setAttribute("aria-controls", list.id);
  control.append(trigger, list);
  select.replaceWith(control);

  let rows: { option: HTMLOptionElement; element: HTMLElement }[] = [];
  let active = -1;
  let listeners: AbortController | undefined;

  function updateLabel() {
    valueLabel.textContent = select.selectedOptions[0]?.label ?? "";
  }

  function close() {
    if (!listeners) return;
    listeners.abort();
    listeners = undefined;
    list.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
  }

  function position() {
    if (!trigger.getClientRects().length) return close();
    const anchor = trigger.getBoundingClientRect();
    const above = anchor.top - 14;
    const below = innerHeight - anchor.bottom - 14;
    const flip = list.scrollHeight > below && above > below;
    list.style.maxHeight = `${Math.max(0, Math.min(flip ? above : below, 252))}px`;
    list.style.minWidth = `${Math.max(116, anchor.width)}px`;
    const { width, height } = list.getBoundingClientRect();
    list.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
    list.style.top = `${flip ? anchor.top - height - 6 : anchor.bottom + 6}px`;
  }

  function highlight(index: number, reveal = true) {
    const row = rows[index];
    if (!row || row.option.disabled) return;
    rows[active]?.element.removeAttribute("data-active");
    active = index;
    row.element.dataset.active = "true";
    trigger.setAttribute("aria-activedescendant", row.element.id);
    if (reveal) {
      const bounds = list.getBoundingClientRect();
      const item = row.element.getBoundingClientRect();
      if (item.top < bounds.top + 4) list.scrollTop -= bounds.top + 4 - item.top;
      else if (item.bottom > bounds.bottom - 4) list.scrollTop += item.bottom - bounds.bottom + 4;
    }
  }

  function choose(index: number) {
    const option = rows[index]?.option;
    if (!option || option.disabled) return;
    close();
    if (!option.selected) {
      select.value = option.value;
      updateLabel();
      select.dispatchEvent(new Event("change"));
    }
    select.dispatchEvent(new Event("select"));
  }

  function open(fromEnd = false) {
    if (listeners || trigger.disabled) return;
    rows = Array.from(select.options, (option, index) => {
      const element = document.createElement("div");
      element.className = "select-option";
      element.id = `${list.id}-${index}`;
      element.textContent = option.label;
      element.setAttribute("role", "option");
      element.setAttribute("aria-selected", String(option.selected));
      if (option.disabled) element.setAttribute("aria-disabled", "true");
      element.addEventListener("pointermove", () => highlight(index, false));
      element.addEventListener("click", (event) => {
        event.preventDefault();
        choose(index);
      });
      return { option, element };
    });
    list.replaceChildren(...rows.map(({ element }) => element));
    active = -1;
    trigger.focus({ preventScroll: true });
    trigger.setAttribute("aria-expanded", "true");
    list.showPopover();
    position();
    const selected = rows.findIndex(({ option }) => option.selected && !option.disabled);
    const enabled = rows.flatMap(({ option }, index) => option.disabled ? [] : [index]);
    highlight(selected < 0 ? (fromEnd ? enabled.at(-1) : enabled[0]) ?? -1 : selected);

    listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Node && !control.contains(event.target)) close();
    }, { capture: true, signal });
    window.addEventListener("resize", position, { signal });
    window.addEventListener("scroll", (event) => {
      if (event.target !== list) position();
    }, { capture: true, signal });
  }

  trigger.addEventListener("click", () => listeners ? close() : open());
  trigger.addEventListener("blur", close);
  list.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("[role=option]")) event.preventDefault();
  });
  trigger.addEventListener("keydown", (event) => {
    const { key } = event;
    if (!listeners) {
      if (key !== "ArrowDown" && key !== "ArrowUp") return;
      event.preventDefault();
      open(key === "ArrowUp");
      return;
    }
    if (key === "Tab") return close();
    if (!["Escape", "Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === "Escape") return close();
    if (key === "Enter" || key === " ") return choose(active);
    const enabled = rows.flatMap(({ option }, index) => option.disabled ? [] : [index]);
    const current = enabled.indexOf(active);
    if (key === "Home") highlight(enabled[0]);
    else if (key === "End") highlight(enabled.at(-1) ?? -1);
    else highlight(enabled[current + (key === "ArrowDown" ? 1 : -1)]);
  });

  updateLabel();
  return {
    get value() { return select.value; },
    set value(value: string) {
      select.value = value;
      updateLabel();
    },
    get selectedIndex() { return select.selectedIndex; },
    set disabled(disabled: boolean) {
      trigger.disabled = disabled;
      if (disabled) close();
    },
    onChange: (run: () => void) => select.addEventListener("change", run),
    onSelect: (run: () => void) => select.addEventListener("select", run),
  };
}
