const PROVIDER_ICONS = {
  claude: '/provider-logos/claude.svg',
  ollama: '/provider-logos/ollama.svg',
  cloudru: '/provider-logos/cloudru.svg',
  yandex: '/provider-logos/yandex.svg',
};

export function makeProviderIcon(value, className) {
  const source = value === 'codex'
    ? document.documentElement.dataset.theme === 'light'
      ? '/provider-logos/openai.svg'
      : '/provider-logos/openai-white.svg'
    : PROVIDER_ICONS[value];
  if (!source) return null;

  const icon = document.createElement('img');
  icon.className = className;
  icon.src = source;
  icon.alt = '';
  icon.dataset.provider = value;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function enhanceSelect(select) {
  const field = select.closest('.codex-field');
  const label = field?.querySelector(':scope > span');
  if (!field || !label || !select.id) return null;

  const labelId = label.id || `${select.id}-label`;
  label.id = labelId;

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  wrapper.dataset.selectId = select.id;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}-custom`;
  trigger.className = 'modal-input codex-select custom-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-labelledby', labelId);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${select.id}-options`);

  const valueContent = document.createElement('span');
  valueContent.className = 'custom-select-value';
  const valueLabel = document.createElement('span');
  valueLabel.className = 'custom-select-label';
  valueContent.append(valueLabel);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.id = `${select.id}-options`;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-labelledby', labelId);
  menu.setAttribute('popover', 'manual');
  menu.hidden = true;
  if (typeof menu.showPopover !== 'function') menu.removeAttribute('popover');

  trigger.append(valueContent);
  select.parentElement.insertBefore(wrapper, select);
  wrapper.append(select, trigger, menu);
  select.hidden = true;
  select.tabIndex = -1;
  select.classList.add('custom-select-native');
  select.setAttribute('aria-hidden', 'true');

  let activeIndex = -1;
  let typeahead = '';
  let typeaheadTimer = 0;
  let isPopoverOpen = false;

  function optionNodes() {
    return [...menu.querySelectorAll('[role="option"]')];
  }

  function setActive(index) {
    const options = optionNodes();
    if (!options.length) return;

    const direction = index < activeIndex ? -1 : 1;
    let next = ((index % options.length) + options.length) % options.length;
    for (let attempts = 0; attempts < options.length && options[next].getAttribute('aria-disabled') === 'true'; attempts += 1) {
      next = (next + direction + options.length) % options.length;
    }

    activeIndex = next;
    options.forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === next));
    trigger.setAttribute('aria-activedescendant', options[next].id);
    options[next].scrollIntoView({ block: 'nearest' });
  }

  function positionMenu() {
    const rect = trigger.getBoundingClientRect();
    const edge = 8;
    const roomBelow = Math.max(0, window.innerHeight - rect.bottom - edge - 4);
    const roomAbove = Math.max(0, rect.top - edge - 4);
    const placeAbove = roomBelow < Math.min(menu.scrollHeight, 180) && roomAbove > roomBelow;
    const available = placeAbove ? roomAbove : roomBelow;
    const height = Math.min(menu.scrollHeight, 260, available || 260);
    const left = Math.max(edge, Math.min(rect.left, window.innerWidth - rect.width - edge));

    menu.style.left = `${left}px`;
    menu.style.width = `${Math.min(rect.width, window.innerWidth - edge * 2)}px`;
    menu.style.maxHeight = `${Math.max(80, height)}px`;
    menu.style.top = placeAbove
      ? `${Math.max(edge, rect.top - height - 4)}px`
      : `${Math.min(window.innerHeight - height - edge, rect.bottom + 4)}px`;
  }

  function close({ focus = false } = {}) {
    if (isPopoverOpen) menu.hidePopover();
    isPopoverOpen = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    if (focus) trigger.focus();
  }

  function open(initialIndex = select.selectedIndex, direction = 1) {
    if (select.disabled || !select.options.length) return;
    menu.hidden = false;
    if (typeof menu.showPopover === 'function') {
      menu.showPopover();
      isPopoverOpen = true;
    }
    positionMenu();
    trigger.setAttribute('aria-expanded', 'true');
    const options = optionNodes();
    const startIndex = ((initialIndex % options.length) + options.length) % options.length;
    const enabledIndex = Array.from({ length: options.length }, (_, offset) => (
      (startIndex + direction * offset + options.length) % options.length
    )).find((index) => options[index].getAttribute('aria-disabled') !== 'true');
    if (enabledIndex !== undefined) setActive(enabledIndex);
  }

  function choose(optionIndex) {
    const option = select.options[optionIndex];
    if (!option || option.disabled || select.disabled) return;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close({ focus: true });
  }

  function refresh() {
    const current = select.options[select.selectedIndex];
    const nextContent = document.createDocumentFragment();
    const icon = current && makeProviderIcon(current.value, 'custom-select-icon');
    if (icon) nextContent.append(icon);
    valueLabel.textContent = current?.label || current?.textContent || '';
    nextContent.append(valueLabel);
    valueContent.replaceChildren(nextContent);

    menu.replaceChildren(...[...select.options].map((option, index) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      item.id = `${select.id}-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      if (option.disabled) item.setAttribute('aria-disabled', 'true');

      const optionIcon = makeProviderIcon(option.value, 'custom-select-icon');
      if (optionIcon) item.append(optionIcon);
      const text = document.createElement('span');
      text.className = 'custom-select-option-copy';
      const label = document.createElement('span');
      label.className = 'custom-select-label';
      label.textContent = option.label || option.textContent || '';
      text.append(label);
      if (option.dataset.description) {
        const description = document.createElement('span');
        description.className = 'custom-select-description';
        description.textContent = option.dataset.description;
        text.append(description);
      }
      item.append(text);
      if (option.dataset.badge) {
        const badge = document.createElement('span');
        badge.className = 'custom-select-badge';
        badge.textContent = option.dataset.badge;
        item.append(badge);
      }
      return item;
    }));

    trigger.disabled = select.disabled || ![...select.options].some((option) => !option.disabled);
    trigger.title = valueLabel.textContent;
  }

  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') close();
    else open();
  });
  label.addEventListener('click', () => trigger.focus());

  trigger.addEventListener('keydown', (event) => {
    const isOpen = trigger.getAttribute('aria-expanded') === 'true';
    const options = optionNodes();

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab' && isOpen) {
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!isOpen) open(select.selectedIndex + direction, direction);
      else setActive(activeIndex + direction);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!isOpen) open(event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1);
      else setActive(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && isOpen) {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase();
      window.clearTimeout(typeaheadTimer);
      typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 700);
      const start = isOpen ? activeIndex + 1 : Math.max(select.selectedIndex, 0);
      for (let offset = 0; offset < options.length; offset += 1) {
        const index = (start + offset) % options.length;
        if (options[index].getAttribute('aria-disabled') !== 'true'
          && select.options[index].textContent.trim().toLocaleLowerCase().startsWith(typeahead)) {
          if (!isOpen) open(index);
          else setActive(index);
          break;
        }
      }
    }
  });

  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option && menu.contains(option)) choose(Number(option.id.slice(`${select.id}-option-`.length)));
  });
  menu.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option && menu.contains(option)) setActive(Number(option.id.slice(`${select.id}-option-`.length)));
  });
  select.addEventListener('change', refresh);
  document.addEventListener('pointerdown', (event) => {
    if (!wrapper.contains(event.target) && trigger.getAttribute('aria-expanded') === 'true') close();
  });
  window.addEventListener('resize', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') positionMenu();
  });
  window.addEventListener('scroll', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') positionMenu();
  }, true);
  field.closest('dialog')?.addEventListener('close', () => close());

  const observer = new MutationObserver(refresh);
  observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
  refresh();
  return { refresh };
}

export function enhanceCustomSelects(root = document) {
  const controls = [...root.querySelectorAll('select')].map(enhanceSelect).filter(Boolean);
  return {
    refresh() {
      controls.forEach((control) => control.refresh());
    },
  };
}
